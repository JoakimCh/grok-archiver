#!/usr/bin/env node
import {startup, archiveImage, archivedImages, log, debug, getResponseBody} from 'archivers-common'
import {createRequire} from 'node:module'
const {name: archiverName, version} = createRequire(import.meta.url)('./package.json')

const storedDetails = new Map()
const catchResponses = [
  {
    from: 'https://x.com*',
    intercept: [
      '*add_response.json',
      '*grok-attachment/*', // https://ton.x.com/i/ton/data/grok-attachment/IMG_ID
      '*attachment.json?mediaId*',
      '*GrokConversationItemsByRestId*',
      '*GrokMediaHistory*'
    ],
    enableNetworkFetch: true, // helps fetch some cached stuff
    // serviceWorkerOnly: true,
  }
]
const isArchiving = new Set()

startup({archiverName, version, initialUrl: 'https://x.com/i/grok', catchResponses, responseReceivedHandler})

// (response header received)
async function responseReceivedHandler({initiator, sessionId, networkId, requestId, request, response, asFetch}) {
  function _debug(title, error) {
    debug(`${title}: ${asFetch} ${networkId || requestId} ${request.method} ${response.status} ${request.url.split('?')[0]} ${error ? 'ERROR: '+error : ''}`)
  }
  try {
    if (response.status != 200) throw 'not 200'
    if (request.method == 'OPTIONS') return
    // const headers = new Headers(responseHeaders.map(({name, value}) => [name, value]))
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    switch (pathParts.at(-1)) {
      default:
        if (pathParts.at(-3) == 'grok-attachment') {
          return // these are incomplete images
        } else if (pathParts.at(-2) != 'grok-attachment') {
          throw `unhandled response URL: ${request.url}`
        } // notice no break here; so it will do the next case:
      case 'attachment.json':
        return await fetchAndArchive({
          sessionId, requestId, asFetch, 
          id: url.searchParams.get('mediaId') || pathParts.at(-1)
        })
      case 'add_response.json':
        _debug('add_response')
        return handle_add_response(await getResponseBody(arguments[0]))
      case 'GrokConversationItemsByRestId':
        _debug('conversation')
        return handle_GrokConversationItems(await getResponseBody(arguments[0]))
      case 'GrokMediaHistory':
        _debug('imageHistory')
        return handle_GrokMediaHistory(await getResponseBody(arguments[0]))
    }
  } catch (error) {
    _debug('RESPONSE HANDLING ERROR', error)
  }
}

async function fetchAndArchive({id, asFetch, sessionId, requestId}) {
  id += ''
  if (isArchiving.has(id) || archivedImages.has(id)) {
    return
  }
  isArchiving.add(id)
  const imgData = await getResponseBody({asFetch, sessionId, requestId})
  archiveImage({id, details: storedDetails.get(id), imgData})
  storedDetails.delete(id)
  isArchiving.delete(id)
}

function handle_add_response(data) {
  let prompt, imageCount = 0, pendingId = new Set(), detailsStored = 0
  const blocks = parseJsonBlocks(data.toString())
  for (const block of blocks) {
    const {result} = block
    if (!result) {
      if (block.userChatItemId) continue
      log('No result in block:', block)
      continue
    }
    const {
      query, 
      imageAttachmentCount,
      imageAttachment // on completetion
    } = result
    if (imageAttachmentCount) {
      imageCount = imageAttachmentCount
    }
    if (imageCount && query) {
      prompt = query
    }
    if (result.event?.imageAttachmentUpdate) {
      const {imageId, progress} = result.event.imageAttachmentUpdate
      pendingId.add(''+imageId)
    }
    if (imageAttachment?.mediaId) { // completed image
      const id = ''+imageAttachment.mediaId
      // debug(`Got prompt for ${id}: ${prompt}`)
      storedDetails.set(id, {id, prompt, unixTime: Math.trunc(Date.now() / 1000)})
      detailsStored ++
      pendingId.delete(id)
    }
  }
  // all blocks read
  for (const id of pendingId) {
    log(`Generation error, but you might catch the image here: https://x.com/i/grok/media/${id}`)
    storedDetails.set(id, {id, prompt, unixTime: Math.trunc(Date.now() / 1000)})
    detailsStored ++
  }
  if (detailsStored != imageCount) {
    log(`Generation failure.`)
  }
}

function handle_GrokConversationItems(data) {
  data = JSON.parse(data.toString())
  const items = data?.data?.grok_conversation_items_by_rest_id?.items || []
  for (const {message, media_urls, created_at_ms} of items) {
    if (media_urls) {
      for (const media_url of media_urls) {
        const start = media_url.lastIndexOf('mediaId=')
        if (start) {
          const id = media_url.slice(start+8)
          const prompt = message.slice(message.indexOf("prompt: '") + 9, -1)
          if (!(archivedImages.has(id) || isArchiving.has(id))) {
            storedDetails.set(id, {
              id, prompt, unixTime: Math.trunc(created_at_ms/1000)
            })
          }
        }
      }
    }
  }
}

function handle_GrokMediaHistory(data) {
  data = JSON.parse(data.toString())
  const items = data?.data?.grok_media_history?.items || []
  for (const {media_id: id, created_at_ms} of items) {
    if (!(archivedImages.has(id) || isArchiving.has(id))) {
      storedDetails.set(id, {
        id, unixTime: Math.trunc(created_at_ms/1000)
      })
    }
  }
}

function parseJsonBlocks(text) {
  if (!text.startsWith('{')) {
    throw 'error, missing { in: '+text
  }
  const blocks = []
  let open = 0, block = ''
  for (const char of text) {
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
