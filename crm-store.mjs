import fs from 'node:fs';
import path from 'node:path';
import { WAMessageStubType } from 'baileys';

const configuredRetention = Number(process.env.CRM_MAX_MESSAGES_PER_CHAT || 0);
const MAX_MESSAGES_PER_CHAT = Number.isFinite(configuredRetention) && configuredRetention > 0
  ? Math.floor(configuredRetention)
  : 0;

const numberValue = value => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const unwrapMessage = message => {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message);
  return message;
};

const messageText = message => {
  const m = unwrapMessage(message);
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || '📷 Imagem';
  if (m.videoMessage) return m.videoMessage.caption || '🎥 Vídeo';
  if (m.audioMessage) return '🎵 Áudio';
  if (m.documentMessage) return '📄 ' + (m.documentMessage.fileName || 'Documento');
  if (m.stickerMessage) return '🖼️ Figurinha';
  if (m.contactMessage) return '👤 Contato';
  if (m.contactsArrayMessage) return '👥 Contatos';
  if (m.locationMessage) return '📍 Localização';
  if (m.liveLocationMessage) return '📍 Localização ao vivo';
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return '📊 Enquete';
  if (m.reactionMessage) return '↪️ Reação';
  return '[Mensagem]';
};

const messageType = message => {
  const m = unwrapMessage(message);
  if (!m) return 'unknown';
  return Object.keys(m)[0] || 'unknown';
};

const safeNameFromJid = jid => {
  if (!jid) return 'Sem nome';
  return jid.split('@')[0]?.replace(/\D/g, '') || jid;
};

const asBuffer = value => {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
};

const thumbnailDataUrl = (value, mimetype = 'image/jpeg') => {
  const buffer = asBuffer(value);
  if (!buffer || buffer.length === 0 || buffer.length > 256 * 1024) return null;
  return 'data:' + mimetype + ';base64,' + buffer.toString('base64');
};

const mediaInfo = message => {
  const m = unwrapMessage(message);
  if (!m) return null;

  let kind = null;
  let value = null;
  if (m.imageMessage) { kind = 'image'; value = m.imageMessage; }
  else if (m.videoMessage) { kind = 'video'; value = m.videoMessage; }
  else if (m.audioMessage) { kind = 'audio'; value = m.audioMessage; }
  else if (m.documentMessage) { kind = 'document'; value = m.documentMessage; }
  else if (m.stickerMessage) { kind = 'sticker'; value = m.stickerMessage; }
  if (!kind || !value) return null;

  return {
    kind,
    mimetype: value.mimetype || null,
    fileName: value.fileName || value.title || null,
    caption: value.caption || null,
    seconds: numberValue(value.seconds) || null,
    width: numberValue(value.width) || null,
    height: numberValue(value.height) || null,
    fileLength: numberValue(value.fileLength) || null,
    ptt: !!value.ptt,
    animated: !!value.isAnimated,
    thumbnail: thumbnailDataUrl(value.jpegThumbnail, 'image/jpeg')
  };
};

const locationInfo = message => {
  const m = unwrapMessage(message);
  if (!m) return null;
  const loc = m.liveLocationMessage || m.locationMessage || null;
  if (!loc || loc.degreesLatitude == null || loc.degreesLongitude == null) return null;
  return {
    latitude: Number(loc.degreesLatitude),
    longitude: Number(loc.degreesLongitude),
    accuracy: loc.accuracyInMeters == null ? null : Number(loc.accuracyInMeters),
    speed: loc.speedInMps == null ? null : Number(loc.speedInMps),
    live: !!(m.liveLocationMessage || loc.isLive),
    sequenceNumber: numberValue(loc.sequenceNumber),
    name: loc.name || null,
    address: loc.address || null,
    caption: loc.caption || loc.comment || null
  };
};

export function createCrmStore(dataDir) {
  const file = path.join(path.dirname(dataDir), 'crm-state.json');
  let state = {
    version: 2,
    rev: 0,
    updatedAt: Date.now(),
    chats: {},
    messages: {},
    contacts: {},
    groups: {},
    labels: {},
    chatLabels: {},
    lidMap: {},
    presences: {}
  };
  let saveTimer = null;

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        ...state,
        ...parsed,
        version: 2,
        chats: parsed.chats || {},
        messages: parsed.messages || {},
        contacts: parsed.contacts || {},
        groups: parsed.groups || {},
        labels: parsed.labels || {},
        chatLabels: parsed.chatLabels || {},
        lidMap: parsed.lidMap || {},
        presences: parsed.presences || {}
      };
    }
  } catch (error) {
    console.error('[crm] failed to load state', error?.message || error);
  }

  const saveNow = () => {
    try {
      state.updatedAt = Date.now();
      fs.writeFileSync(file + '.tmp', JSON.stringify(state));
      fs.renameSync(file + '.tmp', file);
    } catch (error) {
      console.error('[crm] failed to save state', error?.message || error);
    }
  };

  const touch = () => {
    state.rev = (state.rev || 0) + 1;
    state.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  };

  const aliasFor = jid => state.lidMap[jid] || null;

  const contactFor = jid => {
    const direct = state.contacts[jid] || {};
    const alias = aliasFor(jid);
    const mapped = alias ? (state.contacts[alias] || {}) : {};

    if (String(jid || '').endsWith('@lid') && String(alias || '').endsWith('@s.whatsapp.net')) {
      return { ...direct, ...mapped, id: jid };
    }
    return { ...mapped, ...direct, id: jid };
  };

  const chatName = jid => {
    const group = state.groups[jid];
    if (group?.subject) return group.subject;
    const c = contactFor(jid);
    const chat = state.chats[jid] || {};
    return c.name || c.notify || c.verifiedName || chat.name || chat.pushName || safeNameFromJid(jid);
  };

  const ensureChat = jid => {
    if (!jid || jid === 'status@broadcast') return null;
    state.chats[jid] ||= { id: jid, archived: false, unreadCount: 0 };
    return state.chats[jid];
  };

  const upsertChat = (input, { historical = false } = {}) => {
    const jid = input?.id;
    if (!jid || jid === 'status@broadcast') return;
    const existed = !!state.chats[jid];
    const chat = ensureChat(jid);
    const previousTimestamp = numberValue(chat.lastMessageTimestamp || chat.conversationTimestamp);
    const incomingTimestamp = numberValue(input.lastMessageTimestamp || input.conversationTimestamp);

    const next = { ...input };
    delete next.conditional;
    delete next.lastMessageTimestamp;
    delete next.conversationTimestamp;
    delete next.lastMessage;
    delete next.unreadCount;
    delete next.archived;
    Object.assign(chat, next);

    if (!historical || !existed) {
      if (typeof input.archived === 'boolean') chat.archived = input.archived;
      if (typeof input.unreadCount === 'number') chat.unreadCount = input.unreadCount;
    }

    const effectiveTimestamp = Math.max(previousTimestamp, incomingTimestamp);
    if (effectiveTimestamp > 0) {
      chat.lastMessageTimestamp = effectiveTimestamp;
      chat.conversationTimestamp = effectiveTimestamp;
    }
    if (incomingTimestamp >= previousTimestamp && input.lastMessage != null) {
      chat.lastMessage = input.lastMessage;
    }
    touch();
  };

  const mergeMappedContacts = (pnJid, lidJid) => {
    const pn = state.contacts[pnJid] || {};
    const lid = state.contacts[lidJid] || {};
    const preferred = { ...lid, ...pn };

    state.contacts[pnJid] = {
      ...preferred,
      id: pnJid,
      lid: lidJid,
      phoneNumber: pnJid
    };
    state.contacts[lidJid] = {
      ...lid,
      ...pn,
      id: lidJid,
      lid: lidJid,
      phoneNumber: pnJid
    };
  };

  const upsertContact = input => {
    const jid = input?.id;
    if (!jid) return;
    const merged = { ...(state.contacts[jid] || {}), ...input };
    state.contacts[jid] = merged;

    if (input.lid && input.phoneNumber) {
      state.lidMap[input.lid] = input.phoneNumber;
      state.lidMap[input.phoneNumber] = input.lid;
      mergeMappedContacts(input.phoneNumber, input.lid);
    } else if (input.lid) {
      state.lidMap[input.lid] = input.phoneNumber || jid;
      if (input.phoneNumber) state.lidMap[input.phoneNumber] = input.lid;
    } else if (input.phoneNumber) {
      state.lidMap[input.phoneNumber] = input.lid || jid;
      if (input.lid) state.lidMap[input.lid] = input.phoneNumber;
    }
    touch();
  };

  const upsertLidMapping = mapping => {
    if (!mapping?.pn || !mapping?.lid) return;
    state.lidMap[mapping.lid] = mapping.pn;
    state.lidMap[mapping.pn] = mapping.lid;
    mergeMappedContacts(mapping.pn, mapping.lid);
    touch();
  };

  const upsertGroup = input => {
    const jid = input?.id;
    if (!jid) return;
    const group = {
      id: jid,
      subject: input.subject || state.groups[jid]?.subject || jid,
      desc: input.desc || state.groups[jid]?.desc || '',
      size: input.size ?? input.participants?.length ?? state.groups[jid]?.size ?? 0,
      creation: input.creation || state.groups[jid]?.creation || 0
    };
    state.groups[jid] = { ...(state.groups[jid] || {}), ...group };
    ensureChat(jid);
    touch();
  };

  const upsertMessage = (raw, { countUnread = true } = {}) => {
    const jid = raw?.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    const id = raw?.key?.id;
    if (!id) return;

    const chat = ensureChat(jid);
    const ts = numberValue(raw.messageTimestamp) || Math.floor(Date.now() / 1000);
    const location = locationInfo(raw.message);
    const media = mediaInfo(raw.message);
    const item = {
      id,
      jid,
      fromMe: !!raw.key.fromMe,
      participant: raw.key.participant || null,
      pushName: raw.pushName || null,
      timestamp: ts,
      text: messageText(raw.message),
      type: messageType(raw.message),
      deleted: false,
      location,
      media
    };

    const arr = state.messages[jid] ||= [];
    const idx = arr.findIndex(x => x.id === id);
    const previous = idx >= 0 ? arr[idx] : null;

    if (previous) {
      arr[idx] = {
        ...previous,
        ...item,
        deleted: !!previous.deleted,
        deletedAt: previous.deletedAt || null,
        deletedForEveryone: !!previous.deletedForEveryone,
        location: location || previous.location || null,
        media: media || previous.media || null
      };
    } else {
      arr.push(item);
    }

    arr.sort((a, b) => a.timestamp - b.timestamp);
    if (MAX_MESSAGES_PER_CHAT > 0 && arr.length > MAX_MESSAGES_PER_CHAT) {
      arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT);
    }

    const previousLast = numberValue(chat.lastMessageTimestamp || chat.conversationTimestamp);
    if (ts >= previousLast) {
      chat.lastMessageTimestamp = ts;
      chat.conversationTimestamp = ts;
      chat.lastMessage = item.text;
    }
    if (raw.pushName && !chat.pushName) chat.pushName = raw.pushName;
    if (countUnread && idx < 0 && !item.fromMe) {
      chat.unreadCount = Number(chat.unreadCount || 0) + 1;
    }
    touch();
  };

  const mergeHistory = payload => {
    for (const map of payload?.lidPnMappings || []) upsertLidMapping(map);
    for (const c of payload?.contacts || []) upsertContact(c);
    for (const g of payload?.groups || []) upsertGroup(g);
    for (const c of payload?.chats || []) upsertChat(c, { historical: true });
    for (const m of payload?.messages || []) upsertMessage(m, { countUnread: false });
  };

  const markDeleted = payload => {
    if (!payload?.keys) return;
    for (const key of payload.keys) {
      const jid = key?.remoteJid;
      const id = key?.id;
      if (!jid || !id) continue;
      for (const bucket of [jid, aliasFor(jid)].filter(Boolean)) {
        const arr = state.messages[bucket] || [];
        const item = arr.find(x => x.id === id);
        if (item) {
          item.deleted = true;
          item.deletedAt = Date.now();
        }
      }
    }
    touch();
  };

  const handleMessageUpdates = updates => {
    let changed = false;

    for (const entry of updates || []) {
      const key = entry?.key;
      const update = entry?.update || {};
      const jid = key?.remoteJid;
      const id = key?.id;
      if (!jid || !id) continue;

      const buckets = [...new Set([jid, aliasFor(jid)].filter(Boolean))];
      const items = [];
      for (const bucket of buckets) {
        const found = (state.messages[bucket] || []).find(x => x.id === id);
        if (found) items.push(found);
      }

      if (update.message === null && Number(update.messageStubType) === Number(WAMessageStubType.REVOKE)) {
        for (const item of items) {
          item.deleted = true;
          item.deletedAt = Date.now();
          item.deletedForEveryone = true;
          changed = true;
        }
        continue;
      }

      if (update.message) {
        const location = locationInfo(update.message);
        const media = mediaInfo(update.message);
        const text = messageText(update.message);
        const type = messageType(update.message);

        for (const item of items) {
          if (location) {
            const previousSequence = numberValue(item.location?.sequenceNumber);
            const nextSequence = numberValue(location.sequenceNumber);
            if (!previousSequence || !nextSequence || nextSequence >= previousSequence) {
              item.location = { ...(item.location || {}), ...location };
              item.text = location.live ? '📍 Localização ao vivo' : '📍 Localização';
              item.type = type;
              changed = true;
            }
          }
          if (media) {
            item.media = { ...(item.media || {}), ...media };
            if (text && text !== '[Mensagem]') item.text = text;
            item.type = type;
            changed = true;
          }
        }
      }

      if (update.status != null) {
        for (const item of items) {
          item.status = Number(update.status);
          changed = true;
        }
      }
    }

    if (changed) touch();
  };

  const upsertPresence = payload => {
    if (!payload) return;
    const now = Date.now();
    let chosen = null;
    for (const [jid, data] of Object.entries(payload.presences || {})) {
      const value = {
        lastKnownPresence: data?.lastKnownPresence || 'unavailable',
        lastSeen: data?.lastSeen == null ? null : Number(data.lastSeen),
        groupOnlineCount: data?.groupOnlineCount == null ? null : Number(data.groupOnlineCount),
        updatedAt: now
      };
      state.presences[jid] = value;
      chosen = value;
    }
    if (payload.id && chosen) state.presences[payload.id] = chosen;
    touch();
  };

  const editLabel = label => {
    if (!label?.id) return;
    if (label.deleted) delete state.labels[label.id];
    else state.labels[label.id] = { ...label };
    touch();
  };

  const labelAssociation = ({ association, type }) => {
    const chatId = association?.chatId;
    const labelId = association?.labelId;
    if (!chatId || !labelId) return;
    const labels = new Set(state.chatLabels[chatId] || []);
    if (type === 'remove') labels.delete(labelId);
    else labels.add(labelId);
    state.chatLabels[chatId] = [...labels];
    touch();
  };

  const listChats = ({ archived = false, search = '', labelId = '' } = {}) => {
    const q = String(search || '').trim().toLowerCase();
    return Object.values(state.chats)
      .filter(c => !!c.archived === !!archived)
      .filter(c => !labelId || (state.chatLabels[c.id] || []).includes(labelId))
      .map(c => ({
        id: c.id,
        name: chatName(c.id),
        archived: !!c.archived,
        unreadCount: Number(c.unreadCount || 0),
        lastMessage: c.lastMessage || '',
        lastMessageTimestamp: Number(c.lastMessageTimestamp || c.conversationTimestamp || 0),
        isGroup: c.id.endsWith('@g.us'),
        labels: state.chatLabels[c.id] || [],
        avatar: (() => {
          const contact = contactFor(c.id);
          return contact?.imgUrl && contact.imgUrl !== 'changed' ? contact.imgUrl : null;
        })(),
        presence: state.presences[c.id] || null
      }))
      .filter(c => !q || (c.name + ' ' + c.id + ' ' + c.lastMessage).toLowerCase().includes(q))
      .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
  };

  const resolveSendJid = jid => {
    const value = String(jid || '');
    if (!value || value.endsWith('@g.us') || value.endsWith('@s.whatsapp.net')) return value;
    if (value.endsWith('@lid')) {
      const mapped = state.lidMap[value];
      if (mapped && String(mapped).endsWith('@s.whatsapp.net')) return String(mapped);
      const contact = contactFor(value);
      if (contact?.phoneNumber && String(contact.phoneNumber).endsWith('@s.whatsapp.net')) {
        return String(contact.phoneNumber);
      }
    }
    return value;
  };

  const mergedMessages = jid => {
    const alias = aliasFor(jid);
    const ids = [...new Set([jid, alias].filter(Boolean))];
    const byId = new Map();

    for (const bucket of ids) {
      for (const message of state.messages[bucket] || []) {
        const key = String(message?.id || '') + '|' + String(message?.fromMe ? 1 : 0);
        const current = byId.get(key);
        if (!current || Number(message?.timestamp || 0) >= Number(current?.timestamp || 0)) {
          byId.set(key, message);
        }
      }
    }

    return [...byId.values()].sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
  };

  const getMessagesPage = (jid, { limit = 120, before = 0, offset = 0 } = {}) => {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 120));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const beforeTs = Math.max(0, Number(before) || 0);

    let all = mergedMessages(jid);
    if (beforeTs > 0) all = all.filter(m => Number(m?.timestamp || 0) < beforeTs);

    const end = Math.max(0, all.length - safeOffset);
    const start = Math.max(0, end - safeLimit);
    const messages = all.slice(start, end);

    return {
      jid,
      messages,
      total: all.length,
      hasMore: start > 0,
      nextBefore: start > 0 && messages.length ? Number(messages[0]?.timestamp || 0) : null
    };
  };

  const getMessages = (jid, limit = 100) => getMessagesPage(jid, { limit }).messages;

  const markReadLocal = jid => {
    const ids = [...new Set([jid, aliasFor(jid)].filter(Boolean))];
    let changed = false;
    for (const id of ids) {
      const chat = ensureChat(id);
      if (!chat) continue;
      if (chat.unreadCount) changed = true;
      chat.unreadCount = 0;
    }
    if (changed) touch();
  };

  const snapshot = ({ archived = false, search = '', labelId = '', limit = 0, offset = 0, includeMeta = true } = {}) => {
    const allChats = listChats({ archived, search, labelId });
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(0, Number(limit) || 0);
    const chats = safeLimit > 0
      ? allChats.slice(safeOffset, safeOffset + safeLimit)
      : allChats.slice(safeOffset);

    return {
      rev: state.rev,
      updatedAt: state.updatedAt,
      chats,
      totalChats: allChats.length,
      hasMore: safeLimit > 0 ? safeOffset + chats.length < allChats.length : false,
      labels: includeMeta ? Object.values(state.labels).filter(x => !x.deleted) : [],
      groups: includeMeta ? Object.values(state.groups).sort((a, b) => String(a.subject).localeCompare(String(b.subject))) : [],
      archivedCount: Object.values(state.chats).filter(c => !!c.archived).length,
      unreadTotal: Object.values(state.chats).reduce((n, c) => n + Number(c.unreadCount || 0), 0)
    };
  };

  const attach = sock => {
    sock.ev.on('messaging-history.set', mergeHistory);
    sock.ev.on('chats.upsert', chats => chats.forEach(c => upsertChat(c)));
    sock.ev.on('chats.update', chats => chats.forEach(c => upsertChat(c)));
    sock.ev.on('contacts.upsert', contacts => contacts.forEach(upsertContact));
    sock.ev.on('contacts.update', contacts => contacts.forEach(upsertContact));
    sock.ev.on('lid-mapping.update', upsertLidMapping);
    sock.ev.on('messages.upsert', ({ messages, type }) => messages.forEach(m => upsertMessage(m, { countUnread: type === 'notify' })));
    sock.ev.on('messages.update', handleMessageUpdates);
    sock.ev.on('messages.delete', markDeleted);
    sock.ev.on('presence.update', upsertPresence);
    sock.ev.on('groups.upsert', groups => groups.forEach(upsertGroup));
    sock.ev.on('groups.update', groups => groups.forEach(upsertGroup));
    sock.ev.on('labels.edit', editLabel);
    sock.ev.on('labels.association', labelAssociation);
  };

  const syncGroups = async sock => {
    const groups = await sock.groupFetchAllParticipating();
    Object.values(groups || {}).forEach(upsertGroup);
    return Object.keys(groups || {}).length;
  };

  const close = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
  };

  return {
    state,
    attach,
    syncGroups,
    upsertMessage,
    upsertChat,
    upsertGroup,
    upsertContact,
    upsertLidMapping,
    upsertPresence,
    handleMessageUpdates,
    snapshot,
    resolveSendJid,
    getMessages,
    getMessagesPage,
    markReadLocal,
    saveNow,
    close
  };
}
