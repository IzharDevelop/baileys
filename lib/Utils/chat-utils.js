"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
const boom_1 = require("@hapi/boom")
const WAProto_1 = require("../../WAProto")
const LabelAssociation_1 = require("../Types/LabelAssociation")
const WABinary_1 = require("../WABinary")
const crypto_1 = require("./crypto")
const generics_1 = require("./generics")
const lt_hash_1 = require("./lt-hash")
const messages_media_1 = require("./messages-media")
const mutationKeys = async (keydata) => {
const expanded = await crypto_1.hkdf(keydata, 160, { info: 'WhatsApp Mutation Keys' })
return {
indexKey: expanded.slice(0, 32),
valueEncryptionKey: expanded.slice(32, 64),
valueMacKey: expanded.slice(64, 96),
snapshotMacKey: expanded.slice(96, 128),
patchMacKey: expanded.slice(128, 160)
}
}
const generateMac = (operation, data, keyId, key) => {
const getKeyData = () => {
let r
switch (operation) {
case WAProto_1.proto.SyncdMutation.SyncdOperation.SET:
r = 0x01
break
case WAProto_1.proto.SyncdMutation.SyncdOperation.REMOVE:
r = 0x02
break
}
const buff = Buffer.from([r])
return Buffer.concat([buff, Buffer.from(keyId, 'base64')])
}
const keyData = getKeyData()
const last = Buffer.alloc(8)
last.set([keyData.length], last.length - 1)
const total = Buffer.concat([keyData, data, last])
const hmac = crypto_1.hmacSign(total, key, 'sha512')
return hmac.slice(0, 32)
}
const to64BitNetworkOrder = (e) => {
const buff = Buffer.alloc(8)
buff.writeUint32BE(e, 4)
return buff
}
const makeLtHashGenerator = ({ indexValueMap, hash }) => {
indexValueMap = { ...indexValueMap }
const addBuffs = []
const subBuffs = []
return {
mix: ({ indexMac, valueMac, operation }) => {
const indexMacBase64 = Buffer.from(indexMac).toString('base64')
const prevOp = indexValueMap[indexMacBase64]
if (operation === WAProto_1.proto.SyncdMutation.SyncdOperation.REMOVE) {
if (!prevOp) {
throw new boom_1.Boom('tried remove, but no previous op', { data: { indexMac, valueMac } })
}
delete indexValueMap[indexMacBase64]
}
else {
addBuffs.push(new Uint8Array(valueMac).buffer)
indexValueMap[indexMacBase64] = { valueMac }
}
if (prevOp) {
subBuffs.push(new Uint8Array(prevOp.valueMac).buffer)
}
},
finish: async () => {
const hashArrayBuffer = new Uint8Array(hash).buffer
const result = await lt_hash_1.LT_HASH_ANTI_TAMPERING.subtractThenAdd(hashArrayBuffer, addBuffs, subBuffs)
const buffer = Buffer.from(result)
return {
hash: buffer,
indexValueMap
}
}
}
}
const generateSnapshotMac = (lthash, version, name, key) => {
const total = Buffer.concat([
lthash,
to64BitNetworkOrder(version),
Buffer.from(name, 'utf-8')
])
return crypto_1.hmacSign(total, key, 'sha256')
}
const generatePatchMac = (snapshotMac, valueMacs, version, type, key) => {
const total = Buffer.concat([
snapshotMac,
...valueMacs,
to64BitNetworkOrder(version),
Buffer.from(type, 'utf-8')
])
return crypto_1.hmacSign(total, key)
}
const newLTHashState = () => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} })
const encodeSyncdPatch = async ({ type, index, syncAction, apiVersion, operation }, myAppStateKeyId, state, getAppStateSyncKey) => {
const key = myAppStateKeyId ? await getAppStateSyncKey(myAppStateKeyId) : undefined
if (!key) {
throw new boom_1.Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { statusCode: 404 })
}
const encKeyId = Buffer.from(myAppStateKeyId, 'base64')
state = { ...state, indexValueMap: { ...state.indexValueMap } }
const indexBuffer = Buffer.from(JSON.stringify(index))
const dataProto = WAProto_1.proto.SyncActionData.fromObject({
index: indexBuffer,
value: syncAction,
padding: new Uint8Array(0),
version: apiVersion
})
const encoded = WAProto_1.proto.SyncActionData.encode(dataProto).finish()
const keyValue = await mutationKeys(key.keyData)
const encValue = crypto_1.aesEncrypt(encoded, keyValue.valueEncryptionKey)
const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey)
const indexMac = crypto_1.hmacSign(indexBuffer, keyValue.indexKey)
const generator = makeLtHashGenerator(state)
generator.mix({ indexMac, valueMac, operation })
Object.assign(state, await generator.finish())
state.version += 1
const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey)
const patch = {
patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
snapshotMac: snapshotMac,
keyId: { id: encKeyId },
mutations: [
{
operation: operation,
record: {
index: {
blob: indexMac
},
value: {
blob: Buffer.concat([encValue, valueMac])
},
keyId: { id: encKeyId }
}
}
]
}
const base64Index = indexMac.toString('base64')
state.indexValueMap[base64Index] = { valueMac }
return { patch, state }
}
const decodeSyncdMutations = async (msgMutations, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
const ltGenerator = makeLtHashGenerator(initialState)
for (const msgMutation of msgMutations) {
const operation = 'operation' in msgMutation ? msgMutation.operation : WAProto_1.proto.SyncdMutation.SyncdOperation.SET
const record = ('record' in msgMutation && !!msgMutation.record) ? msgMutation.record : msgMutation
const key = await getKey(record.keyId.id)
const content = Buffer.from(record.value.blob)
const encContent = content.slice(0, -32)
const ogValueMac = content.slice(-32)
if (validateMacs) {
const contentHmac = generateMac(operation, encContent, record.keyId.id, key.valueMacKey)
if (Buffer.compare(contentHmac, ogValueMac) !== 0) {
throw new boom_1.Boom('HMAC content verification failed')
}
}
const result = crypto_1.aesDecrypt(encContent, key.valueEncryptionKey)
const syncAction = WAProto_1.proto.SyncActionData.decode(result)
if (validateMacs) {
const hmac = crypto_1.hmacSign(syncAction.index, key.indexKey)
if (Buffer.compare(hmac, record.index.blob) !== 0) {
throw new boom_1.Boom('HMAC index verification failed')
}
}
const indexStr = Buffer.from(syncAction.index).toString()
onMutation({ syncAction, index: JSON.parse(indexStr) })
ltGenerator.mix({
indexMac: record.index.blob,
valueMac: ogValueMac,
operation: operation
})
}
return await ltGenerator.finish()
async function getKey(keyId) {
const base64Key = Buffer.from(keyId).toString('base64')
const keyEnc = await getAppStateSyncKey(base64Key)
if (!keyEnc) {
throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`, { statusCode: 404, data: { msgMutations } })
}
return mutationKeys(keyEnc.keyData)
}
}
const decodeSyncdPatch = async (msg, name, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
if (validateMacs) {
const base64Key = Buffer.from(msg.keyId.id).toString('base64')
const mainKeyObj = await getAppStateSyncKey(base64Key)
if (!mainKeyObj) {
throw new boom_1.Boom(`failed to find key "${base64Key}" to decode patch`, { statusCode: 404, data: { msg } })
}
const mainKey = await mutationKeys(mainKeyObj.keyData)
const mutationmacs = msg.mutations.map(mutation => mutation.record.value.blob.slice(-32))
const patchMac = generatePatchMac(msg.snapshotMac, mutationmacs, generics_1.toNumber(msg.version.version), name, mainKey.patchMacKey)
if (Buffer.compare(patchMac, msg.patchMac) !== 0) {
throw new boom_1.Boom('Invalid patch mac')
}
}
const result = await decodeSyncdMutations(msg.mutations, initialState, getAppStateSyncKey, onMutation, validateMacs)
return result
}
const extractSyncdPatches = async (result, options) => {
const syncNode = WABinary_1.getBinaryNodeChild(result, 'sync')
const collectionNodes = WABinary_1.getBinaryNodeChildren(syncNode, 'collection')
const final = {}
await Promise.all(collectionNodes.map(async (collectionNode) => {
const patchesNode = WABinary_1.getBinaryNodeChild(collectionNode, 'patches')
const patches = WABinary_1.getBinaryNodeChildren(patchesNode || collectionNode, 'patch')
const snapshotNode = WABinary_1.getBinaryNodeChild(collectionNode, 'snapshot')
const syncds = []
const name = collectionNode.attrs.name
const hasMorePatches = collectionNode.attrs.has_more_patches === 'true'
let snapshot = undefined
if (snapshotNode && !!snapshotNode.content) {
if (!Buffer.isBuffer(snapshotNode)) {
snapshotNode.content = Buffer.from(Object.values(snapshotNode.content))
}
const blobRef = WAProto_1.proto.ExternalBlobReference.decode(snapshotNode.content)
const data = await downloadExternalBlob(blobRef, options)
snapshot = WAProto_1.proto.SyncdSnapshot.decode(data)
}
for (let { content } of patches) {
if (content) {
if (!Buffer.isBuffer(content)) {
content = Buffer.from(Object.values(content))
}
const syncd = WAProto_1.proto.SyncdPatch.decode(content)
if (!syncd.version) {
syncd.version = { version: +collectionNode.attrs.version + 1 }
}
syncds.push(syncd)
}
}
final[name] = { patches: syncds, hasMorePatches, snapshot }
}))
return final
}
const downloadExternalBlob = async (blob, options) => {
const stream = await messages_media_1.downloadContentFromMessage(blob, 'md-app-state', { options })
const bufferArray = []
for await (const chunk of stream) {
bufferArray.push(chunk)
}
return Buffer.concat(bufferArray)
}
const downloadExternalPatch = async (blob, options) => {
const buffer = await downloadExternalBlob(blob, options)
const syncData = WAProto_1.proto.SyncdMutations.decode(buffer)
return syncData
}
const decodeSyncdSnapshot = async (name, snapshot, getAppStateSyncKey, minimumVersionNumber, validateMacs = true) => {
const newState = newLTHashState()
newState.version = generics_1.toNumber(snapshot.version.version)
const mutationMap = {}
const areMutationsRequired = typeof minimumVersionNumber === 'undefined'
|| newState.version > minimumVersionNumber
const { hash, indexValueMap } = await decodeSyncdMutations(snapshot.records, newState, getAppStateSyncKey, areMutationsRequired
? (mutation) => {
const index = mutation.syncAction.index?.toString()
mutationMap[index] = mutation
}
: () => { }, validateMacs)
newState.hash = hash
newState.indexValueMap = indexValueMap
if (validateMacs) {
const base64Key = Buffer.from(snapshot.keyId.id).toString('base64')
const keyEnc = await getAppStateSyncKey(base64Key)
if (!keyEnc) {
throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`)
}
const result = await mutationKeys(keyEnc.keyData)
const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
if (Buffer.compare(snapshot.mac, computedSnapshotMac) !== 0) {
throw new boom_1.Boom(`failed to verify LTHash at ${newState.version} of ${name} from snapshot`)
}
}
return {
state: newState,
mutationMap
}
}
const decodePatches = async (name, syncds, initial, getAppStateSyncKey, options, minimumVersionNumber, logger, validateMacs = true) => {
const newState = {
...initial,
indexValueMap: { ...initial.indexValueMap }
}
const mutationMap = {}
for (const syncd of syncds) {
const { version, keyId, snapshotMac } = syncd
if (syncd.externalMutations) {
logger?.trace({ name, version }, 'downloading external patch')
const ref = await downloadExternalPatch(syncd.externalMutations, options)
logger?.debug({ name, version, mutations: ref.mutations.length }, 'downloaded external patch')
syncd.mutations?.push(...ref.mutations)
}
const patchVersion = generics_1.toNumber(version.version)
newState.version = patchVersion
const shouldMutate = typeof minimumVersionNumber === 'undefined' || patchVersion > minimumVersionNumber
const decodeResult = await decodeSyncdPatch(syncd, name, newState, getAppStateSyncKey, shouldMutate
? mutation => {
const index = mutation.syncAction.index?.toString()
mutationMap[index] = mutation
}
: (() => { }), true)
newState.hash = decodeResult.hash
newState.indexValueMap = decodeResult.indexValueMap
if (validateMacs) {
const base64Key = Buffer.from(keyId.id).toString('base64')
const keyEnc = await getAppStateSyncKey(base64Key)
if (!keyEnc) {
throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`)
}
const result = await mutationKeys(keyEnc.keyData)
const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
if (Buffer.compare(snapshotMac, computedSnapshotMac) !== 0) {
throw new boom_1.Boom(`failed to verify LTHash at ${newState.version} of ${name}`)
}
}
syncd.mutations = []
}
return { state: newState, mutationMap }
}
const chatModificationToAppPatch = (mod, jid) => {
const OP = WAProto_1.proto.SyncdMutation.SyncdOperation
const getMessageRange = (lastMessages) => {
let messageRange
if (Array.isArray(lastMessages)) {
const lastMsg = lastMessages[lastMessages.length - 1]
messageRange = {
lastMessageTimestamp: lastMsg?.messageTimestamp,
messages: lastMessages?.length ? lastMessages.map(m => {
if (!((m.key?.id) || (m.key?.remoteJid))) {
throw new boom_1.Boom('Incomplete key', { statusCode: 400, data: m })
}
if (WABinary_1.isJidGroup(m.key.remoteJid) && !m.key.fromMe && !m.key.participant) {
throw new boom_1.Boom('Expected not from me message to have participant', { statusCode: 400, data: m })
}
if (!m.messageTimestamp || !generics_1.toNumber(m.messageTimestamp)) {
throw new boom_1.Boom('Missing timestamp in last message list', { statusCode: 400, data: m })
}
if (m.key.participant) {
m.key.participant = WABinary_1.jidNormalizedUser(m.key.participant)
}
return m
}) : undefined
}
}
else {
messageRange = lastMessages
}
return messageRange
}
let patch
if ('mute' in mod) {
patch = {
syncAction: {
muteAction: {
muted: !!mod.mute,
muteEndTimestamp: mod.mute || undefined
}
},
index: ['mute', jid],
type: 'regular_high',
apiVersion: 2,
operation: OP.SET
}
}
else if ('archive' in mod) {
patch = {
syncAction: {
archiveChatAction: {
archived: !!mod.archive,
messageRange: getMessageRange(mod.lastMessages)
}
},
index: ['archive', jid],
type: 'regular_low',
apiVersion: 3,
operation: OP.SET
}
}
else if ('markRead' in mod) {
patch = {
syncAction: {
markChatAsReadAction: {
read: mod.markRead,
messageRange: getMessageRange(mod.lastMessages)
}
},
index: ['markChatAsRead', jid],
type: 'regular_low',
apiVersion: 3,
operation: OP.SET
}
}
else if ('deleteForMe' in mod) {
const { timestamp, key, deleteMedia } = mod.deleteForMe
patch = {
syncAction: {
deleteMessageForMeAction: {
deleteMedia,
messageTimestamp: timestamp
}
},
index: ['deleteMessageForMe', jid, key.id, key.fromMe ? '1' : '0', '0'],
type: 'regular_high',
apiVersion: 3,
operation: OP.SET
}
}
else if ('clear' in mod) {
patch = {
syncAction: {
clearChatAction: {}
},
index: ['clearChat', jid, '1', '0'],
type: 'regular_high',
apiVersion: 6,
operation: OP.SET
}
}
else if ('pin' in mod) {
patch = {
syncAction: {
pinAction: {
pinned: !!mod.pin
}
},
index: ['pin_v1', jid],
type: 'regular_low',
apiVersion: 5,
operation: OP.SET
}
}
else if ('contact' in mod) {
patch = {
syncAction: {
contactAction: mod?.contact || {}
}, 
index: ['contact', jid], 
type: 'critical_unblock_low', 
apiVersion: 2,
operation: mod.contact ? OP.SET : OP.REMOVE
}
}
else if ('star' in mod) {
const key = mod.star.messages[0]
patch = {
syncAction: {
starAction: {
starred: !!mod.star.star
}
},
index: ['star', jid, key.id, key.fromMe ? '1' : '0', '0'],
type: 'regular_low',
apiVersion: 2,
operation: OP.SET
}
}
else if ('delete' in mod) {
patch = {
syncAction: {
deleteChatAction: {
messageRange: getMessageRange(mod.lastMessages),
}
},
index: ['deleteChat', jid, '1'],
type: 'regular_high',
apiVersion: 6,
operation: OP.SET
}
}
else if ('pushNameSetting' in mod) {
patch = {
syncAction: {
pushNameSetting: {
name: mod.pushNameSetting
}
},
index: ['setting_pushName'],
type: 'critical_block',
apiVersion: 1,
operation: OP.SET,
}
}
else if ('addLabel' in mod) {
patch = {
syncAction: {
labelEditAction: {
name: mod.addLabel.name,
color: mod.addLabel.color,
predefinedId: mod.addLabel.predefinedId,
deleted: mod.addLabel.deleted
}
},
index: ['label_edit', mod.addLabel.id],
type: 'regular',
apiVersion: 3,
operation: OP.SET,
}
}
else if ('addChatLabel' in mod) {
patch = {
syncAction: {
labelAssociationAction: {
labeled: true,
}
},
index: [LabelAssociation_1.LabelAssociationType.Chat, mod.addChatLabel.labelId, jid],
type: 'regular',
apiVersion: 3,
operation: OP.SET,
}
}
else if ('removeChatLabel' in mod) {
patch = {
syncAction: {
labelAssociationAction: {
labeled: false,
}
},
index: [LabelAssociation_1.LabelAssociationType.Chat, mod.removeChatLabel.labelId, jid],
type: 'regular',
apiVersion: 3,
operation: OP.SET,
}
}
else if ('addMessageLabel' in mod) {
patch = {
syncAction: {
labelAssociationAction: {
labeled: true,
}
},
index: [
LabelAssociation_1.LabelAssociationType.Message,
mod.addMessageLabel.labelId,
jid,
mod.addMessageLabel.messageId,
'0',
'0'
],
type: 'regular',
apiVersion: 3,
operation: OP.SET,
}
}
else if ('removeMessageLabel' in mod) {
patch = {
syncAction: {
labelAssociationAction: {
labeled: false,
}
},
index: [
LabelAssociation_1.LabelAssociationType.Message,
mod.removeMessageLabel.labelId,
jid,
mod.removeMessageLabel.messageId,
'0',
'0'
],
type: 'regular',
apiVersion: 3,
operation: OP.SET,
}
}
else {
throw new boom_1.Boom('not supported')
}
patch.syncAction.timestamp = Date.now()
return patch
}
const processSyncAction = (syncAction, ev, me, initialSyncOpts, logger) => {
const isInitialSync = !!initialSyncOpts
const accountSettings = initialSyncOpts?.accountSettings
logger?.trace({ syncAction, initialSync: !!initialSyncOpts }, 'processing sync action')
const { syncAction: { value: action }, index: [type, id, msgId, fromMe] } = syncAction
if (action?.muteAction) {
ev.emit('chats.update', [
{
id,
muteEndTime: action.muteAction?.muted
? generics_1.toNumber(action.muteAction.muteEndTimestamp)
: null,
conditional: getChatUpdateConditional(id, undefined)
}
])
}
else if (action?.archiveChatAction || type === 'archive' || type === 'unarchive') {
const archiveAction = action?.archiveChatAction
let isArchived = archiveAction
? archiveAction.archived
: type === 'archive'
if (isInitialSync && !isArchived) {
isArchived = false
}
const msgRange = !accountSettings?.unarchiveChats ? undefined : archiveAction?.messageRange
logger?.debug({ chat: id, syncAction }, 'message range archive')
ev.emit('chats.update', [{
id,
archived: isArchived,
conditional: getChatUpdateConditional(id, msgRange)
}])
}
else if (action?.markChatAsReadAction) {
const markReadAction = action.markChatAsReadAction
const isNullUpdate = isInitialSync && markReadAction.read
ev.emit('chats.update', [{
id,
unreadCount: isNullUpdate ? null : markReadAction?.read ? 0 : -1,
conditional: getChatUpdateConditional(id, markReadAction?.messageRange)
}])
}
else if (action?.deleteMessageForMeAction || type === 'deleteMessageForMe') {
ev.emit('messages.delete', {
keys: [
{
remoteJid: id,
id: msgId,
fromMe: fromMe === '1'
}
]
})
}
else if (action?.contactAction) {
ev.emit('contacts.upsert', [{ id, name: action.contactAction.fullName }])
}
else if (action?.pushNameSetting) {
const name = action?.pushNameSetting?.name
if (name && me?.name !== name) {
ev.emit('creds.update', { me: { ...me, name } })
}
}
else if (action?.pinAction) {
ev.emit('chats.update', [{
id,
pinned: action.pinAction?.pinned ? generics_1.toNumber(action.timestamp) : null,
conditional: getChatUpdateConditional(id, undefined)
}])
}
else if (action?.unarchiveChatsSetting) {
const unarchiveChats = !!action.unarchiveChatsSetting.unarchiveChats
ev.emit('creds.update', { accountSettings: { unarchiveChats } })
logger?.info(`archive setting updated => '${action.unarchiveChatsSetting.unarchiveChats}'`)
if (accountSettings) {
accountSettings.unarchiveChats = unarchiveChats
}
}
else if (action?.starAction || type === 'star') {
let starred = action?.starAction?.starred
if (typeof starred !== 'boolean') {
starred = syncAction.index[syncAction.index.length - 1] === '1'
}
ev.emit('messages.update', [
{
key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' },
update: { starred }
}
])
}
else if (action?.deleteChatAction || type === 'deleteChat') {
if (!isInitialSync) {
ev.emit('chats.delete', [id])
}
}
else if (action?.labelEditAction) {
const { name, color, deleted, predefinedId } = action.labelEditAction
ev.emit('labels.edit', {
id,
name: name,
color: color,
deleted: deleted,
predefinedId: predefinedId ? String(predefinedId) : undefined
})
}
else if (action?.labelAssociationAction) {
ev.emit('labels.association', {
type: action.labelAssociationAction.labeled
? 'add'
: 'remove',
association: type === LabelAssociation_1.LabelAssociationType.Chat
? {
type: LabelAssociation_1.LabelAssociationType.Chat,
chatId: syncAction.index[2],
labelId: syncAction.index[1]
}
: {
type: LabelAssociation_1.LabelAssociationType.Message,
chatId: syncAction.index[2],
messageId: syncAction.index[3],
labelId: syncAction.index[1]
}
})
}
else {
logger?.debug({ syncAction, id }, 'unprocessable update')
}
function getChatUpdateConditional(id, msgRange) {
return isInitialSync
? (data) => {
const chat = data.historySets.chats[id] || data.chatUpserts[id]
if (chat) {
return msgRange ? isValidPatchBasedOnMessageRange(chat, msgRange) : true
}
}
: undefined
}
function isValidPatchBasedOnMessageRange(chat, msgRange) {
const lastMsgTimestamp = Number(msgRange?.lastMessageTimestamp || msgRange?.lastSystemMessageTimestamp || 0)
const chatLastMsgTimestamp = Number(chat?.lastMessageRecvTimestamp || 0)
return lastMsgTimestamp >= chatLastMsgTimestamp
}
}
module.exports = {
mutationKeys, 
newLTHashState, 
encodeSyncdPatch, 
decodeSyncdMutations, 
decodeSyncdPatch, 
extractSyncdPatches, 
downloadExternalBlob, 
downloadExternalPatch, 
decodeSyncdSnapshot, 
decodePatches, 
chatModificationToAppPatch, 
processSyncAction
}