"use strict"
var __importDefault = (this && this.__importDefault) || function (mod) {
return (mod && mod.__esModule) ? mod : { "default": mod }
}
Object.defineProperty(exports, "__esModule", { value: true })
const async_mutex_1 = __importDefault(require("async-mutex"))
const promises_1 = require("fs/promises")
const path_1 = require("path")
const WAProto_1 = require("../../WAProto")
const auth_utils_1 = require("./auth-utils")
const generics_1 = require("./generics")
const fileLocks = new Map()
const getFileLock = (path) => {
let mutex = fileLocks.get(path)
if (!mutex) {
mutex = new async_mutex_1.Mutex() 
fileLocks.set(path, mutex)
}
return mutex
}
const useMultiFileAuthState = async (folder) => {
const writeData = async (data, file) => {
const filePath = path_1.join(folder, fixFileName(file))
const mutex = getFileLock(filePath)
return mutex.acquire().then(async (release) => {
try {
await promises_1.writeFile(filePath, JSON.stringify(data, generics_1.BufferJSON.replacer))
} finally {
release()
}
})
}
const readData = async (file) => {
try {
const filePath = path_1.join(folder, fixFileName(file))
const mutex = getFileLock(filePath)
const data = await mutex.acquire().then(async (release) => {
try {
return await promises_1.readFile(filePath, { encoding: 'utf-8' })
} finally {
release()
}
})
return JSON.parse(data, generics_1.BufferJSON.reviver)
} catch {
return null
}
}
const removeData = async (file) => {
try {
const filePath = path_1.join(folder, fixFileName(file))
const mutex = getFileLock(filePath)
await mutex.acquire().then(async (release) => {
try {
await promises_1.unlink(filePath)
} finally {
release()
}
})
} catch {
// ignore
}
}
const folderInfo = await promises_1.stat(folder).catch(() => { })
if (folderInfo) {
if (!folderInfo.isDirectory()) {
throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`)
}
}
else {
await promises_1.mkdir(folder, { recursive: true })
}
const fixFileName = (file) => { 
return file?.replace(/\//g, '__')?.replace(/:/g, '-') 
}
const creds = await readData('creds.json') || auth_utils_1.initAuthCreds()
return {
state: {
creds,
keys: {
get: async (type, ids) => {
const data = {}
await Promise.all(ids.map(async (id) => {
let value = await readData(`${type}-${id}.json`)
if (type === 'app-state-sync-key' && value) {
value = WAProto_1.proto.Message.AppStateSyncKeyData.fromObject(value)
}
data[id] = value
}))
return data
},
set: async (data) => {
const tasks = []
for (const category in data) {
for (const id in data[category]) {
const value = data[category][id]
const file = `${category}-${id}.json`
tasks.push(value ? writeData(value, file) : removeData(file))
}
}
await Promise.all(tasks)
}
}
},
saveCreds: async () => {
return writeData(creds, 'creds.json')
}
}
}
module.exports = {
useMultiFileAuthState
}