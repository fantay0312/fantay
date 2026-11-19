// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fei2411 and the DS Bot contributors.
// Modified by Fantay for its channel transport and delivery boundaries.
// WeCom intelligent robot: one long-lived WebSocket, a { cmd, headers: {
// req_id }, body } protocol — aibot_subscribe authenticates, ping heartbeats,
// aibot_msg_callback carries inbound messages answered through
// aibot_respond_msg with the callback's req_id, later messages use
// aibot_send_msg. Template-card buttons come back as aibot_event_callback.
// Encrypted images download with their per-link AES-256 key. Markdown.
// Wire details ported from @wecom/aibot-node-sdk (MIT, see NOTICE).
// The gateway takes a WebSocket on its root path only (/wss answers 403) and
// matches Connection / Upgrade case-sensitively, so the socket comes from `ws`:
// Node's built-in WebSocket sends those header names in lowercase.
import { createDecipheriv } from 'node:crypto'
import WebSocket from 'ws'
import { chunkMarkdown } from '../format.js'

const WSS = 'wss://openws.work.weixin.qq.com'
const TEXT_LIMIT = 4000

const socketUrl = env => String(env.config?.gateway ?? env.config?.api ?? WSS).replace(/\/+$/, '')
// Keep the cause on screen: a refused handshake reports its HTTP status here.
const socketError = (error) => {
  const code = error?.code ?? error?.cause?.code
  const message = String(error?.message ?? error)
  return code !== undefined && !message.includes(code) ? `${message} (${code})` : message
}

export default {
  id: 'wecom',

  // The subscription itself is the credential check: a bad bot id or secret
  // fails the aibot_subscribe response.
  async check(fields, env) {
    const botId = String(fields.botId ?? '').trim()
    const secret = String(fields.secret ?? '').trim()
    return await new Promise((resolve, reject) => {
      let socket
      let settled = false
      const finish = (error, account) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { socket?.terminate() } catch { /* not open */ }
        if (error === undefined) resolve({ account })
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error('WeCom did not answer the subscription')), 10_000)
      try { socket = new WebSocket(socketUrl(env)) } catch (error) {
        finish(new Error(`WeCom could not open a socket: ${socketError(error)}`))
        return
      }
      socket.on('open', () => {
        socket.send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'check-1' }, body: { secret, bot_id: botId } }))
      })
      socket.on('message', (data) => {
        let packet
        try { packet = JSON.parse(String(data)) } catch { return }
        if (packet.errcode === undefined) return
        if (packet.errcode === 0) finish(undefined, { id: botId, name: botId })
        else finish(new Error(String(packet.errmsg ?? `WeCom answered ${packet.errcode}`)))
      })
      socket.on('error', error => finish(new Error(`WeCom could not connect: ${socketError(error)}`)))
      socket.on('close', () => {})
    })
  },

  connect(fields, env, handlers) {
    const botId = String(fields.botId ?? '').trim()
    const secret = String(fields.secret ?? '').trim()
    let stopped = false
    let socket
    let generation = 0
    let reconnectTimer
    let pingTimer
    let reqCounter = 0
    // A refusal is kept on the status while the adapter retries.
    let lastError
    const fail = (message) => {
      lastError = message
      handlers.onStatus({ state: 'error', error: message })
    }
    // Passive replies reuse the last callback req_id per chat.
    const lastReqId = new Map()
    const cardRequests = new Map()
    const pending = new Map() // req_id → {resolve, reject}

    const nextReqId = () => `r${++reqCounter}`
    const sendFrame = (packet) => { if (socket?.readyState === 1) socket.send(JSON.stringify(packet)) }
    const request = (cmd, body, reqId) => {
      const req_id = reqId ?? nextReqId()
      if (socket?.readyState !== 1) return Promise.reject(new Error('WeCom is disconnected'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(req_id)) reject(new Error('WeCom did not answer the send'))
        }, 15_000)
        timer.unref?.()
        pending.set(req_id, {
          resolve: body => { clearTimeout(timer); resolve(body) },
          reject: error => { clearTimeout(timer); reject(error) },
        })
        sendFrame({ cmd, headers: { req_id }, body })
      })
    }

    const onCallback = async (headers, body) => {
      const key = String(body.chattype === 'single' ? body.from?.userid ?? '' : body.chatid ?? '')
      const reqId = String(headers?.req_id ?? '')
      if (reqId) {
        if (lastReqId.size > 2048) lastReqId.delete(lastReqId.keys().next().value)
        const context = { reqId, expires: Date.now() + 4 * 60_000 }
        lastReqId.set(key, context)
        if (body.msgid) lastReqId.set(String(body.msgid), context)
      }
      const direct = body.chattype === 'single'
      // Groups only count when the bot was @-ed: the text keeps the mention.
      const text = String(body.text?.content ?? body.voice?.content ?? '').trim()
      const images = []
      const files = []
      const mediaAllowed = env.admitMedia?.(key, String(body.from?.userid ?? ''), direct, body.mention_robot === true) !== false
      if (mediaAllowed && body.msgtype === 'image' && body.image?.url !== undefined) {
        const bytes = await downloadImage(body.image, env).catch(() => undefined)
        if (bytes !== undefined) images.push({ mediaType: 'image/jpeg', data: Buffer.from(bytes).toString('base64') })
      }
      if (mediaAllowed && body.msgtype === 'file' && body.file?.url !== undefined) {
        const bytes = await downloadImage(body.file, env).catch(() => undefined)
        if (bytes !== undefined) files.push({ name: String(body.file.filename ?? body.file.file_name ?? 'file'), data: bytes })
      }
      if (mediaAllowed && body.msgtype === 'voice' && !text && body.voice?.url !== undefined) {
        const bytes = await downloadImage(body.voice, env).catch(() => undefined)
        if (bytes !== undefined) files.push({ name: '语音消息', data: bytes, audio: true })
      }
      // Reply frames go out with the callback's req_id; a failed reply is
      // logged but the message itself still lands in the core.
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group', title: '' },
        sender: { id: String(body.from?.userid ?? ''), name: String(body.from?.name ?? body.from?.userid ?? '') },
        text, images, files,
        mentioned: body.chattype !== 'single' && body.mention_robot === true,
        messageId: String(body.msgid ?? ''), attachmentCount: Number(['image', 'file', 'voice'].includes(body.msgtype)),
        createdAt: Number(body.create_time) * 1000,
      })
    }

    const onEvent = async (headers, body) => {
      if (body.event?.event_type !== 'template_card_event' && body.event_type !== 'template_card_event') return
      const card = body.event?.template_card_event ?? body.template_card_event ?? {}
      const key = String(body.chattype === 'single' ? body.from?.userid ?? '' : body.chatid ?? card.chatid ?? '')
      const taskId = String(body.event?.task_id ?? card.task_id ?? '')
      const requestId = String(headers?.req_id ?? '')
      if (taskId && requestId) {
        if (cardRequests.size > 128) cardRequests.delete(cardRequests.keys().next().value)
        cardRequests.set(taskId, { requestId, key, expires: Date.now() + 5000 })
      }
      await handlers.onAction({
        chat: { key, kind: body.chattype === 'single' ? 'direct' : 'group', title: '' },
        sender: { id: String(body.from?.userid ?? card.userid ?? ''), name: '' },
        data: String(body.event?.event_key ?? card.event_key ?? card.key ?? ''),
        messageId: taskId || String(body.msgid ?? ''),
      })
    }

    const open = () => {
      const gen = generation
      try { socket = new WebSocket(socketUrl(env)) } catch (error) {
        fail(`WeCom could not open a socket: ${socketError(error)}`)
        return
      }
      socket.on('open', () => {
        sendFrame({ cmd: 'aibot_subscribe', headers: { req_id: nextReqId() }, body: { secret, bot_id: botId } })
      })
      socket.on('message', (data) => {
        if (stopped || generation !== gen) return
        let packet
        try { packet = JSON.parse(String(data)) } catch { return }
        if (packet.errcode !== undefined) {
          if (packet.errcode !== 0) {
            fail(String(packet.errmsg ?? `WeCom answered ${packet.errcode}`))
            const held = pending.get(packet.headers?.req_id)
            if (held !== undefined) {
              pending.delete(packet.headers?.req_id)
              held.reject(Object.assign(new Error(String(packet.errmsg ?? 'WeCom refused')), { permanent: true }))
            }
            return
          }
          if (packet.headers?.req_id !== undefined && pending.has(packet.headers.req_id)) {
            const held = pending.get(packet.headers.req_id)
            pending.delete(packet.headers.req_id)
            held.resolve(packet.body)
          }
          lastError = undefined
          handlers.onStatus({ state: 'ready', account: { id: botId, name: botId } })
          return
        }
        if (packet.cmd === 'aibot_msg_callback') {
          void onCallback(packet.headers, packet.body ?? {}).catch(error => env.log?.warn?.('ds-bot im: wecom message failed: %s', error?.message ?? error))
        } else if (packet.cmd === 'aibot_event_callback') {
          void onEvent(packet.headers, packet.body ?? {}).catch(error => env.log?.warn?.('ds-bot im: wecom event failed: %s', error?.message ?? error))
        }
      })
      socket.on('close', () => {
        clearTimeout(pingTimer)
        if (stopped || generation !== gen) return
        // A refusal stays on screen until a socket subscribes again.
        if (lastError === undefined) handlers.onStatus({ state: 'connecting' })
        reconnectTimer = setTimeout(() => { if (!stopped) open() }, 2000)
        reconnectTimer.unref?.()
      })
      socket.on('error', (error) => {
        if (stopped || generation !== gen) return
        fail(`WeCom socket failed: ${socketError(error)}`)
      })
      pingTimer = setInterval(() => { if (!stopped && socket?.readyState === 1) sendFrame({ cmd: 'ping', headers: { req_id: nextReqId() } }) }, 30_000)
      pingTimer.unref?.()
    }

    handlers.onStatus({ state: 'connecting' })
    open()

    return {
      send: async (chat, { text, buttons, requestId, replyTo }) => {
        const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const body = { msgtype: 'markdown', markdown: { content: chunk } }
          // Buttons ride a template card on the last chunk.
          if (index === chunks.length - 1 && buttons?.length > 0) {
            body.msgtype = 'template_card'
            body.template_card = {
              card_type: 'button_interaction',
              main_title: { title: chunk.split('\n')[0].slice(0, 36), desc: chunk.slice(0, 300) },
              task_id: requestId,
              button_list: buttons.slice(0, 5).map(b => ({ key: b.data, text: b.label.slice(0, 30) })),
            }
          }
          const context = replyTo === null ? undefined : lastReqId.get(replyTo ?? chat.key)
          const result = context && context.expires > Date.now()
            ? await request('aibot_respond_msg', body, context.reqId)
            : await request('aibot_send_msg', { ...body, chatid: chat.key })
          messageId = String(body.template_card?.task_id ?? result?.msgid ?? messageId ?? '')
        }
        return { messageId }
      },
      edit: async (chat, taskId, { text }) => {
        const event = cardRequests.get(taskId)
        if (!event || event.key !== chat.key || event.expires <= Date.now()) return
        cardRequests.delete(taskId)
        await request('aibot_respond_update_msg', { response_type: 'update_template_card', template_card: {
          card_type: 'text_notice', main_title: { title: text.slice(0, 36) }, task_id: taskId,
        } }, event.requestId)
      },
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(reconnectTimer)
        clearTimeout(pingTimer)
        for (const held of pending.values()) held.reject(new Error('stopped'))
        pending.clear()
        try { socket?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

// Images download from their CDN URL and decrypt with the per-link AES-256
// key (base64).
async function downloadImage(image, env) {
  const response = await env.fetch(String(image.url))
  if (!response.ok) return undefined
  const encrypted = Buffer.from(env.readAttachment ? await env.readAttachment(response) : await response.arrayBuffer())
  const key = Buffer.from(String(image.aeskey ?? ''), 'base64')
  if (key.length !== 32) return undefined
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
