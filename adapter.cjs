'use strict'
const kit = require('@solana/kit')
const tokenProgram = require('@solana-program/token')
const token2022 = require('@solana-program/token-2022')
const system = require('@solana-program/system')
const { unsigned, parseAmount } = require('../account-common/amounts.cjs')
const { keyFor } = require('../account-common/keys.cjs')
const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
function decodeMetadata(data, mint) {
  if (data?.owner !== METADATA_PROGRAM || !Array.isArray(data.data) || data.data[1] !== 'base64' || typeof data.data[0] !== 'string' || data.data[0].length > 4096) throw Error('Invalid mint metadata account')
  const bytes = Buffer.from(data.data[0], 'base64')
  if (bytes.length < 77 || bytes[0] !== 4 || !bytes.subarray(33, 65).equals(Buffer.from(kit.getAddressEncoder().encode(mint)))) throw Error('Mint metadata identity mismatch')
  let offset = 65
  const string = limit => {
    if (offset + 4 > bytes.length) throw Error('Truncated mint metadata')
    const size = bytes.readUInt32LE(offset); offset += 4
    if (size > limit || offset + size > bytes.length) throw Error('Invalid mint metadata string')
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + size)).replace(/\0+$/u, '').trim(); offset += size
    return value
  }
  return { name: string(32), symbol: string(10), uri: string(200) }
}
function solAdapter(config, transport) {
  const rpc = transport.rpc
  const normalize = value => kit.address(value)
  function checkContext(response, block) {
    // Requests may reach different PublicNode validators. A minContextSlot
    // equal to a different validator's tip repeatedly fails with -32016.
    // Permit a bounded 150-slot skew, while rejecting stale/malformed reads.
    if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < 0 || block.height - response.context.slot > 150) throw Error('Solana node returned stale account data')
  }
  const inventories = new Map()
  const mintMetadata = new Map()
  let restrictedUntil = 0
  async function head() {
    if (await rpc('getGenesisHash') !== config.genesis) throw Error('Unexpected Solana network')
    const height = await rpc('getSlot', [{ commitment: 'finalized' }])
    if (!Number.isSafeInteger(height) || height < 0) throw Error('Invalid Solana slot')
    return { height }
  }
  async function account(address, block) {
    const response = await rpc('getAccountInfo', [normalize(address), { encoding: 'jsonParsed', commitment: 'finalized' }])
    checkContext(response, block)
    if (!Object.hasOwn(response, 'value')) throw Error('Incomplete Solana account response')
    return response.value
  }
  async function metadataFor(mint, block) {
    const cached = mintMetadata.get(mint)
    if (cached && Date.now() - cached.at < 300000) return cached.value
    try {
      const encode = kit.getAddressEncoder().encode
      const [address] = await kit.getProgramDerivedAddress({ programAddress: METADATA_PROGRAM,
        seeds: [Buffer.from('metadata'), encode(METADATA_PROGRAM), encode(mint)] })
      const value = decodeMetadata(await account(address, block), mint)
      if (mintMetadata.size >= 500) mintMetadata.delete(mintMetadata.keys().next().value)
      mintMetadata.set(mint, { at: Date.now(), value }); return value
    } catch { return cached?.value || {} }
  }
  async function discover(owner, _state, block) {
    if (restrictedUntil > Date.now()) return { candidates: [], complete: false, reason: 'owner-index-restricted' }
    const indexed = new Map(), programs = new Set(), seen = new Set()
    let complete = true
    for (const programId of PROGRAMS) {
      try {
        const result = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'finalized' }])
        checkContext(result, block)
        if (!Array.isArray(result?.value) || result.value.length > 10000) throw Error('Incomplete token account inventory')
        for (const row of result.value) {
          const data = row.account?.data?.parsed, info = data?.info
          if (data?.type !== 'account' || row.account.owner !== programId || info?.owner !== owner) throw Error('Mismatched Solana token owner')
          const mint = normalize(info.mint), entries = indexed.get(mint) || []
          if (seen.has(row.pubkey)) throw Error('Duplicate Solana token account')
          seen.add(row.pubkey)
          entries.push({ address: normalize(row.pubkey), amount: unsigned(info.tokenAmount?.amount, { bits: 64 }).toString(), state: info.state })
          indexed.set(mint, entries)
        }
        programs.add(programId)
      } catch (error) {
        complete = false
        if (error.code === 403 || error.code === 'AUTH_REQUIRED') restrictedUntil = Date.now() + 10 * 60000
      }
    }
    inventories.set(owner, { indexed, programs, at: Date.now() })
    return { candidates: [...indexed.keys()], complete, reason: complete ? null : 'owner-index-restricted' }
  }
  async function token(mint, owner, block, previous = {}) {
    mint = normalize(mint)
    const data = await account(mint, block), parsed = data?.data?.parsed
    if (!PROGRAMS.includes(data?.owner) || parsed?.type !== 'mint' || parsed.info?.isInitialized !== true) throw Error('Address is not an initialized SPL mint')
    const decimals = parsed.info.decimals
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw Error('Invalid mint decimals')
    const inventory = inventories.get(owner)
    const complete = Boolean(inventory && Date.now() - inventory.at < 60000 && inventory.programs.has(data.owner))
    let accountAddresses = complete ? (inventory.indexed.get(mint) || []).map(x => x.address) : null
    if (!accountAddresses) {
      const [ata] = await tokenProgram.findAssociatedTokenPda({ owner, mint, tokenProgram: data.owner })
      accountAddresses = [...new Set([ata, ...(previous.accounts || []).map(x => normalize(x.address))])]
    }
    if (accountAddresses.length > 100) throw Error('Token account inventory exceeds the current request limit')
    const entries = []
    if (accountAddresses.length) {
      const response = await rpc('getMultipleAccounts', [accountAddresses, { encoding: 'jsonParsed', commitment: 'finalized' }])
      checkContext(response, block)
      if (!Array.isArray(response.value) || response.value.length !== accountAddresses.length) throw Error('Incomplete Solana token accounts')
      for (let i = 0; i < response.value.length; i++) {
        const current = response.value[i]
        if (current === null) continue // Closed account is a verified absence.
        const parsedAccount = current?.data?.parsed, info = parsedAccount?.info
        if (current.owner !== data.owner || parsedAccount?.type !== 'account' || info?.mint !== mint || info.owner !== owner || info.tokenAmount?.decimals !== decimals) throw Error('Token account identity mismatch')
        entries.push({ address: accountAddresses[i], amount: unsigned(info.tokenAmount.amount, { bits: 64 }).toString(), state: info.state })
      }
    }
    const extensions = parsed.info.extensions || []
    if (!Array.isArray(extensions)) throw Error('Invalid mint extensions')
    const inlineMetadata = extensions.find(x => x.extension === 'tokenMetadata')?.state
    const metadata = inlineMetadata || await metadataFor(mint, block)
    return { id: mint, name: metadata.name || mint.slice(0, 12), symbol: metadata.symbol || 'SPL', decimals,
      atomic: entries.reduce((sum, row) => sum + unsigned(row.amount), 0n).toString(), complete,
      accounts: entries, program: data.owner, extensions: extensions.map(x => x.extension),
      standard: data.owner === PROGRAMS[0] ? 'SPL' : 'Token-2022' }
  }
  async function balance(owner, block) {
    const result = await rpc('getBalance', [owner, { commitment: 'finalized' }])
    checkContext(result, block)
    return unsigned(result.value, { bits: 64 }).toString()
  }
  async function prepare({ owner, to, amount, asset, assetVerified = false, max }, block) {
    normalize(owner); normalize(to)
    const latest = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]))?.value
    if (!latest || !Number.isSafeInteger(latest.lastValidBlockHeight)) throw Error('Solana blockhash unavailable')
    kit.blockhash(latest.blockhash)
    const payer = kit.createNoopSigner(owner), instructions = []
    const native = unsigned(await balance(owner, block), { bits: 64 })
    let atomic = max ? 1n : parseAmount(amount, asset?.decimals ?? 9, { bits: 64 }), rent = 0n
    if (asset) {
      if (!assetVerified) asset = await token(asset.id, owner, block, asset)
      // Transfer hooks, transfer fees and confidential/non-transferable tokens
      // require specialized account layouts and informed confirmation.
      if (asset.extensions.some(x => !['metadataPointer', 'tokenMetadata', 'mintCloseAuthority'].includes(x))) throw Error('Sending this Token-2022 extension is not supported')
      const sources = asset.accounts.filter(a => a.state === 'initialized' && unsigned(a.amount) > 0n)
      const available = sources.reduce((sum, source) => sum + unsigned(source.amount, { bits: 64 }), 0n)
      if (max) atomic = unsigned(available.toString(), { bits: 64 })
      if (atomic <= 0n || atomic > available) throw Error('No unlocked token account can cover this transfer')
      const [ata] = await tokenProgram.findAssociatedTokenPda({ owner: to, mint: asset.id, tokenProgram: asset.program })
      const destination = await account(ata, block)
      if (destination) {
        const info = destination.data?.parsed?.info
        if (destination.owner !== asset.program || info?.owner !== to || info.mint !== asset.id || info.state !== 'initialized') throw Error('Destination token account is unavailable')
      } else {
        const size = asset.program === PROGRAMS[0] ? 165 : 170 // Token-2022 ATA includes ImmutableOwner.
        rent = unsigned(await rpc('getMinimumBalanceForRentExemption', [size, { commitment: 'confirmed' }]), { bits: 64 })
        instructions.push(await tokenProgram.getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: to, mint: asset.id, tokenProgram: asset.program }))
      }
      const sdk = asset.program === PROGRAMS[0] ? tokenProgram : token2022
      let remaining = atomic
      for (const source of sources) {
        const value = unsigned(source.amount, { bits: 64 }), take = remaining < value ? remaining : value
        instructions.push(sdk.getTransferCheckedInstruction({ source: source.address, mint: asset.id, destination: ata, authority: payer, amount: take, decimals: asset.decimals }))
        remaining -= take
        if (!remaining) break
      }
    } else instructions.push(system.getTransferSolInstruction({ source: payer, destination: to, amount: atomic }))
    const makeMessage = () => kit.appendTransactionMessageInstructions(instructions,
      kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) },
        kit.setTransactionMessageFeePayer(owner, kit.createTransactionMessage({ version: 0 }))))
    let message = makeMessage()
    const feeResponse = await rpc('getFeeForMessage', [Buffer.from(kit.compileTransaction(message).messageBytes).toString('base64'), { commitment: 'confirmed' }])
    if (feeResponse?.value === null || feeResponse?.value === undefined) throw Error('Solana fee unavailable')
    const fee = unsigned(feeResponse.value, { bits: 64 })
    if (max && !asset) {
      atomic = native > fee ? native - fee : 0n
      instructions[0] = system.getTransferSolInstruction({ source: payer, destination: to, amount: atomic }); message = makeMessage()
    }
    if (atomic <= 0n || native < fee + rent + (asset ? 0n : atomic)) throw Error('Insufficient SOL including fee and account rent')
    const wire = kit.compileTransaction(message)
    const serialized = kit.getBase64EncodedWireTransaction(wire)
    if (Buffer.from(serialized, 'base64').length > 1232) throw Error('Token transfer exceeds the Solana transaction size limit')
    // sigVerify=false is read-only and does not sign or broadcast anything.
    const simulation = await rpc('simulateTransaction', [serialized, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }])
    if (!simulation?.value || simulation.value.err) throw Error('Solana transfer simulation failed')
    return { atomic: atomic.toString(), feeAtomic: fee.toString(), rentAtomic: rent.toString(), nativeRequired: (fee + rent).toString(), unsigned: wire }
  }
  async function sign(plan, mnemonic) {
    const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }])
    if (!Number.isSafeInteger(height) || BigInt(height) > plan.unsigned.lifetimeConstraint.lastValidBlockHeight) throw Error('Solana blockhash expired')
    const key = keyFor('solana', mnemonic)
    try {
      if (key.address !== plan.owner) throw Error('Transfer wallet changed')
      const pair = await kit.createKeyPairFromPrivateKeyBytes(key.secret)
      const signed = await kit.signTransaction([pair], plan.unsigned)
      return { serialized: kit.getBase64EncodedWireTransaction(signed), txid: kit.getSignatureFromTransaction(signed) }
    } finally { key.secret.fill(0) }
  }
  async function receipt(txid) {
    const data = await rpc('getSignatureStatuses', [[txid], { searchTransactionHistory: true }])
    if (!Array.isArray(data?.value) || data.value.length !== 1) throw Error('Invalid Solana receipt')
    const status = data.value[0]
    if (!status) return 'unknown'
    return status.confirmationStatus !== 'finalized' ? 'submitted' : status.err ? 'failed' : 'confirmed'
  }
  return { normalize, validate: value => { try { normalize(value); return true } catch { return false } }, head, balance, token, discover, prepare, sign, receipt }
}
module.exports = { solAdapter, PROGRAMS, decodeMetadata, METADATA_PROGRAM }
