#!/usr/bin/env node

import * as fs from 'node:fs'
import {ChromeDevToolsProtocol, initChrome} from 'jlc-cdp'
import * as n_path from 'node:path'
import {createRequire} from 'module'
const require = createRequire(import.meta.url)
const {version} = require('./package.json')

const debug = process.env['DEBUG'] ? (...args) => console.log(...args) : () => {} 
const logInfo = console.log
const log = (...args) => {
  const d = new Date()
  console.log(`[${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}]`, ...args)
}
const storedDetails = new Map()
const archivedImages = new Set()
let cfg, cdp

logInfo('Using grok-archiver version:', version)
handleCliArguments()
try {
  detectArchivedImages() // by checking the DB records
} catch {}
logInfo(`Images archived: ${archivedImages.size}.`)
initializeIntercept()

//#region The functions...

async function initializeIntercept() {
  logInfo('Connecting to the Chrome DevTools Protocol... ')
  const {info} = await (async () => {
    try {
      // see: https://github.com/JoakimCh/grok-archiver/issues/1
      cfg.chromiumArgs = [`https://x.com/i/grok`]
      return await initChrome(cfg)
    } catch (error) {
      if (error.toString().startsWith(`Error: Can't connect to the DevTools protocol`)) {
        console.error(`Could not connect. This usually means that your browser was already running (but without having the CDP port set). If that's the case just close it and run this program again, it will then launch it for you with the correct CDP port configured.`)
      } else {
        console.error(error)
        console.error(`Something went wrong when launching (or connecting to) your browser. Is this the correct path? "${cfg.chromiumPath}"\nIf not then change it in "config.json".`)
      }
      process.exit(1)
    }
  })()
  const {webSocketDebuggerUrl} = info
  const sessions = new Map()

  cdp = new ChromeDevToolsProtocol({webSocketDebuggerUrl, debug: false})

  cdp.on('close', () => {
    logInfo(`The CDP WebSocket connection was closed. Please reconnect by running this program again (if you're not finished).`)
    process.exit()
  })

  cdp.on('Target.targetCreated',     monitorTargetOrNot)
  cdp.on('Target.targetInfoChanged', monitorTargetOrNot)

  function monitorTargetOrNot({targetInfo: {targetId, url, type}}) {
    // debug('monitor?', type, url)
    const startMonitor = async (patterns) => {
      if (!sessions.has(targetId)) {
        debug('start monitor: ', targetId, url)
        const session = cdp.newSession({targetId})
        sessions.set(targetId, session)
        session.once('detached', () => {
          sessions.delete(targetId)
          debug('stop monitor: ', targetId, url)
        })
        try {
          await session.ready // any errors will throw here
          session.send('Fetch.enable', {
            patterns
          }).catch(error => debug(error))
          return session
        } catch (error) { // e.g. if target has been destroyed
          sessions.delete(targetId)
        }
      }
    }
    if (type == 'page' && (url.startsWith('https://x.com/i/grok'))) {
      startMonitor([
        {urlPattern: '*add_response.json', requestStage: 'Response'},
        {urlPattern: '*attachment.json?mediaId*', requestStage: 'Response'},
        {urlPattern: '*GrokConversationItemsByRestId*', requestStage: 'Response'},
      ])
    } else if (type == 'service_worker' && (url.startsWith('https://x.com'))) {
      startMonitor([
        {urlPattern: '*add_response.json', requestStage: 'Response'},
      ])
    } else {
      if (sessions.has(targetId)) {
        sessions.get(targetId).detach().catch(error => debug(error))
        sessions.delete(targetId)
      }
    }
  }

  cdp.on('Fetch.requestPaused', async ({requestId, request, responseStatusCode, responseHeaders}, sessionId) => {
    try { // a failure here must not crash our app
      // debug(responseStatusCode, request.method, request.url)
      switch (request.method) {
        default: return
        case 'POST': case 'GET':
      }
      if (responseStatusCode != 200) {
        return log(`Bad response code (${responseStatusCode}): ${request.url}`)
      }
      const headers = new Headers(responseHeaders.map(({name, value}) => [name, value]))
      const url = new URL(request.url)
      switch (url.pathname.split('/').at(-1)) {
        default: log(url.pathname.split('/').at(-1)); break
        case 'add_response.json': 
          return handle_add_response_json({url, headers, requestId, sessionId})
        case 'attachment.json':
          return handle_attachment_json({url, headers, requestId, sessionId})
        case 'GrokConversationItemsByRestId':
          return handle_GrokConversationItemsByRestId({url, headers, requestId, sessionId})
      }
    } catch (error) {
      log(error)
    } finally { // so even if we return this will be done
      cdp.send('Fetch.continueRequest', {requestId}, sessionId)
    }
  })

  await cdp.ready
  logInfo('Connection successful!')
  
  await cdp.send('Target.setDiscoverTargets', {
    discover: true, // turn on
    filter: [
      {type: 'page'},
      {type: 'service_worker'}
    ]
  })
}

function handle_attachment_json({url, headers, requestId, sessionId}) {
  if (headers.get('content-type') != 'image/jpeg') {
    return debug(`Bad content-type (${headers.get('content-type')}): ${request.method})`)
  }
  const imgId = url.searchParams.get('mediaId')
  if (archivedImages.has(imgId)) {
    return
  }
  cdp.send('Fetch.getResponseBody', {requestId}, sessionId).then(({body, base64Encoded}) => {
    if (!base64Encoded) {
      return debug(`Not base64Encoded: ${imgId}`)
    }
    const imgData = Buffer.from(body, 'base64')
    if (imgData.byteLength == 0) {
      return debug(`Zero length: ${imgId}`) // then we could fetch them instead
    }
    const {
      prompt = '', 
      unixtime = Math.trunc(Date.now() / 1000)
    } = storedDetails.get(imgId) || {}
    storedDetails.delete(imgId)
    log(`Archiving: ${imgId} - ${prompt || '[prompt unknown]'}`)
    const path = `${cfg.archivePath}/images/${dateDir(unixtime)}/${imgFilename({imgId, prompt})}.jpg`
    ensureDirectory(path)
    fs.writeFileSync(path, imgData)
    archivedImages.add(imgId)
    { // archive record
      const path = `${cfg.archivePath}/database/${dateDir(unixtime)}/${imgId}.json`
      ensureDirectory(path)
      fs.writeFileSync(path, JSON.stringify({
        unixtime, imgId, prompt
      }, null, 2))
    }
  }).catch(error => debug(error))
}

function handle_add_response_json({url, headers, requestId, sessionId}) {
  // this stops the streaming of this response to the browser, it's gonna be delivered all at once
  cdp.send('Fetch.getResponseBody', {requestId}, sessionId).then(({body, base64Encoded}) => {
    if (base64Encoded) {
      body = Buffer.from(body, 'base64').toString()
    }
    let prompt, imgId
    const blocks = parseJsonBlocks(body)
    for (const block of blocks) {
      const {result} = block
      if (result?.responseType == 'image') {
        prompt = result.query
      }
      if (result?.imageAttachment?.mediaId) {
        imgId = result.imageAttachment.mediaId
      }
    }
    if (imgId) {
      debug(`Got prompt for ${imgId}: ${prompt}`)
      storedDetails.set(imgId, {prompt})
    } else {
      debug('add_response.json no img', body)
    }
  }).catch(error => debug(error))
}

function handle_GrokConversationItemsByRestId({url, headers, requestId, sessionId}) {
  cdp.send('Fetch.getResponseBody', {requestId}, sessionId).then(({body, base64Encoded}) => {
    if (base64Encoded) {
      body = Buffer.from(body, 'base64').toString()
    }
    const data = JSON.parse(body)
    if (data?.data?.grok_conversation_items_by_rest_id?.items) {
      for (const {message, media_urls, created_at_ms} of data.data.grok_conversation_items_by_rest_id.items) {
        if (media_urls) {
          for (const media_url of media_urls) {
            const start = media_url.lastIndexOf('mediaId=')
            if (start) {
              const imgId = media_url.slice(start+8)
              const prompt = message.slice(39, -2)
              storedDetails.set(imgId, {
                prompt, unixtime: Math.trunc(created_at_ms/1000)
              })
              debug('found', imgId, prompt)
            }
          }
        }
      }
    }
  }).catch(error => debug(error))
}

function detectArchivedImages() {
  const dirsToScan = [`${cfg.archivePath}/database`]
  let path
  while (path = dirsToScan.pop()) {
    for (const entry of fs.readdirSync(path, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        dirsToScan.push(path+'/'+entry.name)
        continue
      }
      if (entry.isFile && entry.name.endsWith('.json')) {
        const imgId = entry.name.slice(0, -5) // without .json
        archivedImages.add(imgId)
      }
    }
  }
}

function handleCliArguments() {
  if (process.argv.length > 2) {
    process.argv.slice(2)
    for (let i=2; i<process.argv.length; i++) {
      const cmd = process.argv[i]
      switch (cmd) {
        case '-v': case '-V': case '--version':
        process.exit()
        case '-h': case '--help': 
          logInfo(`Usage: [--config=location] \nSee https://github.com/JoakimCh/grok-archiver for more help.`)
        process.exit()
        default: {
          if (cmd.startsWith('--config=')) {
            const configPath = cmd.split('=')[1]
            cfg = loadConfig(configPath)
          } else {
            logInfo(`Invalid CLI command: ${cmd}`)
            process.exit(1)
          }
        }
      }
    }
  }
  if (!cfg) cfg = loadConfig() // from CWD
  logInfo('Using archive directory:', cfg.archivePath)
}

function loadConfig(cfgPath = 'config.json') {
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    if (!(typeof cfg.cdpPort == 'number')) throw Error('Missing cdpPort in config.json.')
    if (!(typeof cfg.chromiumPath == 'string')) throw Error('Missing chromiumPath in config.json.')
    if (!(typeof cfg.archivePath == 'string')) throw Error('Missing archivePath in config.json.')
    if (cfg.archivePath.endsWith('/') || cfg.archivePath.endsWith('\\')) {
      cfg.archivePath = cfg.archivePath.slice(0, -1)
    }
    if (!n_path.isAbsolute(cfg.archivePath)) throw Error('The archivePath must be absolute, not this relative path: '+cfg.archivePath)
    cfg.archivePath = cfg.archivePath.replaceAll('\\', '/') // (Windows is FINE with /, we can even mix them)
  } catch (error) {
    logInfo('No valid config.json found, creating one with default values. Please check it before running me again! The error message was:', error.message)
    try {
      cfg = { // some sane defaults
        cdpPort: randomInt(10000, 65534), // some security is provided by not using the default port
        chromiumPath: (()=>{
          switch (process.platform) {
            default:
              return 'google-chrome'
            case 'win32':
              return pickPathThatExists([
                '%ProgramFiles%/Google/Chrome/Application/chrome.exe',
                '%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe',
                '%LocalAppData%/Google/Chrome/Application/chrome.exe'
              ]) || 'c:/path/to/chromium-compatible-browser.exe'
            case 'darwin':
              return pickPathThatExists(['~/Library/Application Support/Google/Chrome']) || '/path/to/chromium-compatible-browser'
          }
        })(),
        archivePath: process.platform == 'win32' ? process.cwd().replaceAll('\\', '/') : process.cwd()
      }
      ensureDirectory(cfgPath)
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    } catch (error) {
      logInfo('Failed creating it, error:', error)
    }
    process.exit()
  }
  return cfg
}

function parseJsonBlocks(text) {
  if (!text.startsWith('{')) {
    console.log('error, missing {')
    return
  }
  const blocks = []
  let open = 0, block = ''
  for (let char of text) {
    switch (char) {
      case '\n': continue
      case '{': open ++; break
      case '}': open --; break
    }
    block += char
    if (open == 0) {
      // convert too large numbers into strings (we could also use BigInts)
      block = block.replace(/(:\s*)(\d{16,})/g, (a,b,c) => {
        if (!Number.isSafeInteger(+c)) {
          return `${b}"${c}"`
        } else {
          return `${b}${c}`
        }
      })
      blocks.push(JSON.parse(block))
      block = ''
    }
  }
  return blocks
}

function pickPathThatExists(choices) {
  for (let path of choices) {
    if (process.platform == 'win32') {
      // thanks to: https://stackoverflow.com/a/33017068/4216153
      path = path.replace(/%([^%]+)%/g, (_, key) => process.env[key]).replaceAll('\\', '/')
    }
    if (fs.existsSync(path)) {
      return path
    }
  }
}

function dateDir(unixTime) {
  const date = new Date(unixTime * 1000)
  return `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`
}

function ensureDirectory(filePath) {
  const dirPath = n_path.dirname(filePath)
  if (!(fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory())) {
    fs.mkdirSync(dirPath, {recursive: true})
  }
}

async function downloadImage(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw `Error downloading image. Response code : ${response.status}.`
  }
  const contentType = response.headers.get('content-type')
  if ('image/jpeg' != contentType) {
    throw `Error downloading image. Content-Type not image/jpeg: ${contentType}.`
  }
  return response.arrayBuffer()
}

function imgFilename({imgId, prompt}) {
  const maxLength = 240
  prompt = prompt
    .replaceAll('. ','_')
    .replaceAll(', ','_')
    .replaceAll('.','_')
    .replaceAll(',','_')
    .replaceAll(' ','-')
    .replace(/[^a-z-_0-9]/gi, '')
  if (prompt.endsWith('_') || prompt.endsWith('-')) {
    prompt = prompt.slice(0, -1)
  }
  const filename = `${imgId}-${prompt}`
  if (filename.length > maxLength) {
    return filename.slice(0, maxLength) + '…'
  }
  return filename
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

//#endregion
