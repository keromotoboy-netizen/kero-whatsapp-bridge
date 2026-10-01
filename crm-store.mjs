import fs from 'node:fs';
import path from 'node:path';
import { WAMessageStubType } from 'baileys';

const MAX_MESSAGES_PER_CHAT = 500;

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
  return message;
};

const messageText = message => {
  const m = unwrapMessage(message);
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || '📷 Imagem';
  if (m.videoMessage) return m.videoMessage.caption || '🎥 Vídeo';  if (m.audioMessage) return '🎵 Áudio';
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

export function createCrmStore(dataDir) {
  const file = path.join(path.dirname(dataDir), 'crm-state.json');
  let state = {
    version: 1, rev: 0, updatedAt: Date.now(),
    chats: {}, messages: {}, contacts: {}, groups: {},
    labels: {}, chatLabels: {}, lidMap: {}, presences: {}
  };
  let saveTimer = null;  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { ...state, ...parsed };
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

  const contactFor = jid => {
    const mapped = state.lidMap[jid];
    return state.contacts[jid] || (mapped ? state.contacts[mapped] : null) || {};
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
  };  const upsertChat = input => {
    const jid = input?.id;
    if (!jid || jid === 'status@broadcast') return;
    const chat = ensureChat(jid);
    const next = { ...input };
    delete next.conditional;
    Object.assign(chat, next);
    if (typeof input.archived === 'boolean') chat.archived = input.archived;
    if (typeof input.unreadCount === 'number') chat.unreadCount = input.unreadCount;
    touch();
  };

  const upsertContact = input => {
    const jid = input?.id;
    if (!jid) return;
    const merged = { ...(state.contacts[jid] || {}), ...input };
    state.contacts[jid] = merged;
    if (input.lid) {
      state.contacts[input.lid] = { ...(state.contacts[input.lid] || {}), ...merged, id: input.lid };
      state.lidMap[input.lid] = input.phoneNumber || jid;
    }
    if (input.phoneNumber) {
      state.contacts[input.phoneNumber] = { ...(state.contacts[input.phoneNumber] || {}), ...merged, id: input.phoneNumber };
      state.lidMap[input.phoneNumber] = input.lid || jid;
    }
    touch();
  };

  const upsertLidMapping = mapping => {
    if (!mapping?.pn || !mapping?.lid) return;
    state.lidMap[mapping.lid] = mapping.pn;
    state.lidMap[mapping.pn] = mapping.lid;
    const pn = state.contacts[mapping.pn];
    const lid = state.contacts[mapping.lid];
    if (pn && !lid) state.contacts[mapping.lid] = { ...pn, id: mapping.lid, lid: mapping.lid, phoneNumber: mapping.pn };
    if (lid && !pn) state.contacts[mapping.pn] = { ...lid, id: mapping.pn, lid: mapping.lid, phoneNumber: mapping.pn };
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

  const upsertMessage = raw => {
    const jid = raw?.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    const id = raw?.key?.id;
    if (!id) return;
    const chat = ensureChat(jid);
    const ts = numberValue(raw.messageTimestamp) || Math.floor(Date.now() / 1000);    const unwrapped = unwrapMessage(raw.message);
    const loc = unwrapped?.liveLocationMessage || unwrapped?.locationMessage || null;
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
      location: loc && loc.degreesLatitude != null && loc.degreesLongitude != null ? {
        latitude: Number(loc.degreesLatitude),
        longitude: Number(loc.degreesLongitude),
        accuracy: loc.accuracyInMeters == null ? null : Number(loc.accuracyInMeters),
        speed: loc.speedInMps == null ? null : Number(loc.speedInMps),
        live: !!(unwrapped?.liveLocationMessage || loc.isLive),
        sequenceNumber: numberValue(loc.sequenceNumber),
        name: loc.name || null,
        address: loc.address || null,
        caption: loc.caption || loc.comment || null
      } : null
    };

    const arr = state.messages[jid] ||= [];
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...item };
    else arr.push(item);
    arr.sort((a,b) => a.timestamp - b.timestamp);
    if (arr.length > MAX_MESSAGES_PER_CHAT) arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT);

    chat.lastMessageTimestamp = ts;
    chat.lastMessage = item.text;
    if (raw.pushName && !chat.pushName) chat.pushName = raw.pushName;
    if (!item.fromMe) chat.unreadCount = Number(chat.unreadCount || 0) + 1;
    touch();
  };

  const mergeHistory = payload => {
    for (const map of payload?.lidPnMappings || []) upsertLidMapping(map);
    for (const c of payload?.contacts || []) upsertContact(c);
    for (const c of payload?.chats || []) upsertChat(c);
    for (const m of payload?.messages || []) upsertMessage(m);
  };

  const markDeleted = payload => {
    if (!payload?.keys) return;
    for (const key of payload.keys) {
      const jid = key?.remoteJid;
      const id = key?.id;
      if (!jid || !id) continue;
      const arr = state.messages[jid] || [];
      const item = arr.find(x => x.id === id);
      if (item) {
        item.deleted = true;
        item.deletedAt = Date.now();
      }
    }
    touch();
  };

  const handleMessageUpdates = updates => {
    let changed = false;
    for (const entry of updates || []) {
      const key = entry?.key;
      const update = entry?.update || {};
      if (update.message === null && Number(update.messageStubType) === Number(WAMessageStubType.REVOKE)) {
        const jid = key?.remoteJid;
        const id = key?.id;
        if (!jid || !id) continue;
        const arr = state.messages[jid] || [];
        const item = arr.find(x => x.id === id);
        if (item) {
          item.deleted = true;
          item.deletedAt = Date.now();
          item.deletedForEveryone = true;
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
    if (!chatId || !labelId) return;    const labels = new Set(state.chatLabels[chatId] || []);
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
      .sort((a,b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
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

  const getMessages = (jid, limit = 100) => {
    const alias = state.lidMap[jid];
    const ids = [...new Set([jid, alias].filter(Boolean))];
    const byId = new Map();

    for (const id of ids) {
      for (const message of state.messages[id] || []) {
        const key = String(message?.id || '') + '|' + String(message?.fromMe ? 1 : 0);
        const current = byId.get(key);
        if (!current || Number(message?.timestamp || 0) >= Number(current?.timestamp || 0)) {
          byId.set(key, message);
        }
      }
    }

    const arr = [...byId.values()].sort((a,b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return arr.slice(Math.max(0, arr.length - safeLimit));
  };

  const markReadLocal = jid => {
    const ids = [...new Set([jid, state.lidMap[jid]].filter(Boolean))];
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
      groups: includeMeta ? Object.values(state.groups).sort((a,b) => String(a.subject).localeCompare(String(b.subject))) : [],
      archivedCount: Object.values(state.chats).filter(c => !!c.archived).length,
      unreadTotal: Object.values(state.chats).reduce((n,c) => n + Number(c.unreadCount || 0), 0)
    };
  };

  const attach = sock => {
    sock.ev.on('messaging-history.set', mergeHistory);
    sock.ev.on('chats.upsert', chats => chats.forEach(upsertChat));
    sock.ev.on('chats.update', chats => chats.forEach(upsertChat));
    sock.ev.on('contacts.upsert', contacts => contacts.forEach(upsertContact));
    sock.ev.on('contacts.update', contacts => contacts.forEach(upsertContact));
    sock.ev.on('lid-mapping.update', upsertLidMapping);
    sock.ev.on('messages.upsert', ({ messages }) => messages.forEach(upsertMessage));
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
    snapshot,
    resolveSendJid,
    getMessages,
    markReadLocal,
    saveNow
  };
}