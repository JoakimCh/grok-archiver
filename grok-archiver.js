#!/usr/bin/env node

import * as fs from 'node:fs'
import {ChromeDevToolsProtocol, initChrome} from 'jlc-cdp'
import * as n_path from 'node:path'
import {createRequire} from 'module'
const require = createRequire(import.meta.url)
const {version} = require('./package.json')

const logInfo = console.log
const log = (...args) => {
  const d = new Date()
  console.log(`[${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}]`, ...args)
}
const storedPrompts = new Map()
const archivedImages = new Set()
let cfg, cdp

logInfo('Using grok-archiver version:', version)

{ // check CLI arguments
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

try {
  detectArchivedImages() // by checking the DB records
} catch {}
logInfo(`Images archived: ${archivedImages.size}.`)

await initializeIntercept()

//#region The functions...

async function initializeIntercept() {
  logInfo('Connecting to the Chrome DevTools Protocol... ')

  const {info} = await initChrome(cfg)
  const {webSocketDebuggerUrl} = info
  const sessions = new Map()

  cdp = new ChromeDevToolsProtocol({webSocketDebuggerUrl, debug: false})

  cdp.on('close', () => logInfo(`The CDP WebSocket connection was closed. Please reconnect by running this program again (if you're not finished).`))

  cdp.on('Target.targetCreated',     monitorTargetOrNot)
  cdp.on('Target.targetInfoChanged', monitorTargetOrNot)

  async function monitorTargetOrNot({targetInfo: {targetId, url, type}}) {
    if (type == 'page' && (url.startsWith('https://x.com/i/grok'))) {
      if (!sessions.has(targetId)) {
        const session = cdp.newSession({targetId})
        sessions.set(targetId, session)
        session.once('detached', () => {
          sessions.delete(targetId)
        })
        await session.ready // any errors will throw here
        await session.send('Fetch.enable', {
          patterns: [
            {urlPattern: '*attachment.json?mediaId*', requestStage: 'Response'},
            // https://api.x.com/2/grok/add_response.json
            {urlPattern: '*add_response.json', requestStage: 'Response'},
          ]
        })
      }
    } else {
      if (sessions.has(targetId)) {
        sessions.get(targetId).detach()
        sessions.delete(targetId)
      }
    }
  }

  cdp.on('Fetch.requestPaused', async ({requestId, request, responseStatusCode, responseHeaders}, sessionId) => {
    try { // a failure here must not crash our app
      switch (request.method) {
        default: return
        case 'POST': case 'GET':
      }
      if (responseStatusCode != 200) {
        return log(`Bad response code ${responseStatusCode}): ${request.url}`)
      }
      const headers = new Headers(responseHeaders.map(({name, value}) => [name, value]))
      if (request.url.endsWith('add_response.json')) {
        // this stops the streaming of this response to the browser, it's gonna be delivered all at once
        cdp.send('Fetch.getResponseBody', {requestId}, sessionId).then(({body, base64Encoded}) => {
          if (base64Encoded) {
            body = Buffer.from(body, 'base64').toString()
          }
          let prompt, imgId
          // console.log(body)
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
            log(`Got prompt for ${imgId}: ${prompt}`)
            storedPrompts.set(imgId, prompt)
          }
        })
        return
      } // yeah, early return here

      if (headers.get('content-type') != 'image/jpeg') {
        return log(`Bad content-type (${headers.get('content-type')}): ${request.method})`)
      }
      // const date = new Date(headers.get('date')) // not of image
      const url = new URL(request.url)
      const imgId = url.searchParams.get('mediaId')
      if (archivedImages.has(imgId)) {
        return
      }
      // I don't await it
      cdp.send('Fetch.getResponseBody', {requestId}, sessionId).then(({body, base64Encoded}) => {
        if (!base64Encoded) {
          return log(`Not base64Encoded: ${imgId}`)
        }
        const imgData = Buffer.from(body, 'base64')
        if (imgData.byteLength == 0) {
          return log(`Zero length: ${imgId}`) // then we can fetch them instead
        }
        const prompt = storedPrompts.get(imgId) || ''
        storedPrompts.delete(imgId)
        log(`Archiving: ${imgId} - ${prompt || '[prompt unknown]'}`)
        const date = Math.trunc(Date.now() / 1000) // unix time
        const path = `${cfg.archivePath}/images/${dateDir(date)}/${imgFilename({imgId, prompt})}.jpg`
        ensureDirectory(path)
        fs.writeFileSync(path, imgData)
        archivedImages.add(imgId)
        { // archive record
          const path = `${cfg.archivePath}/database/${dateDir(date)}/${imgId}.json`
          ensureDirectory(path)
          fs.writeFileSync(path, JSON.stringify({
            date, imgId, prompt
          }, null, 2))
        }
      })
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
    filter: [{type: 'page'}]
  })
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

function dateDir(unixTime) {
  const date = new Date(unixTime * 1000)
  return `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`
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
        const imgId = entry.name
        archivedImages.add(imgId)
      }
    }
  }
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
