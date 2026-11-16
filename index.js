import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const logger = pino({ level: 'silent' });
const KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const BOT = process.env.BOT_NAME || 'OBS MD';
const AUTO = (process.env.AUTO_REPLY || 'true') === 'true';
const MAX_MB = Number(process.env.MAX_MEDIA_MB || 15);
const DIR = './archive';
const MEDIA = path.join(DIR, 'media');
const DB = path.join(DIR, 'index.json');
fs.mkdirSync(MEDIA, { recursive: true });

if (!KEY || KEY.includes('put_your_') || !OWNER || OWNER.includes('X')) {
  console.error('Set OPENAI_API_KEY and OWNER_NUMBER in .env first.');
  process.exit(1);
}

let sockRef;
let reconnecting = false;
let archive = [];
const chats = new Map();
const activeChats = new Set();
const seen = new Set();
try { archive = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(archive.slice(-5000), null, 2));
const digits = j => (j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const owner = j => digits(j) === OWNER;
const group = j => (j || '').endsWith('@g.us');
const pairingNumber = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');

function unwrap(m) {
  let x = m?.message || {};
  for (let i = 0; i < 3; i++) {
    if (x.ephemeralMessage?.message) x = x.ephemeralMessage.message;
    else if (x.deviceSentMessage?.message) x = x.deviceSentMessage.message;
    else break;
  }
  return x;
}
function textOf(msg) {
  const m = unwrap(msg);
  return (m.conversation || m.extendedTextMessage?.text ||
    m.imageMessage?.caption || m.videoMessage?.caption ||
    m.documentMessage?.caption || '').trim();
}
function mediaOf(m) {
  for (const t of ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'])
    if (m[t]) return { type: t, data: m[t] };
  return null;
}
function ext(type, mime='') {
  const x = mime.split('/')[1]?.split(';')[0];
  if (x && /^[a-z0-9.+-]+$/i.test(x)) return x.replace('jpeg','jpg');
  return ({imageMessage:'jpg',videoMessage:'mp4',audioMessage:'ogg',documentMessage:'bin',stickerMessage:'webp'})[type] || 'bin';
}
function settings() {
  const defaults = { ai: AUTO, online: true, dataSaver: true, mediaDownloads: false };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync('./settings.json','utf8')) }; }
  catch { return defaults; }
}
function setSettings(s) { fs.writeFileSync('./settings.json', JSON.stringify(s,null,2)); }

const GROUP_DB = './group-data.json';
let groupData = { groups: {} };

try {
  groupData = JSON.parse(fs.readFileSync(GROUP_DB, 'utf8'));
  if (!groupData.groups) groupData.groups = {};
} catch {}

function saveGroupData() {
  fs.writeFileSync(GROUP_DB, JSON.stringify(groupData, null, 2));
}

function groupRecord(jid) {
  if (!groupData.groups[jid]) {
    groupData.groups[jid] = {
      welcome: true,
      antiSpam: true,
      rules: 'Be respectful. No spam, harassment or abusive content.',
      warnings: {},
      messages: 0,
      joins: 0,
      leaves: 0
    };
  }
  return groupData.groups[jid];
}


async function archiveMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;
  const m = unwrap(msg);
  // Do not save view-once messages or their contents.
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return;
  const id = msg.key.id;
  if (!id || archive.some(a => a.id === id && a.jid === jid)) return;

  const a = {
    id, jid, sender: msg.key.participant || jid, group: group(jid),
    time: Number(msg.messageTimestamp || Date.now()/1000),
    text: textOf(msg), mediaType: null, file: null, deleted: false
  };
  const media = mediaOf(m);
  if (media && !settings().mediaDownloads) {
    a.note = 'Media download skipped by OBS MD data saver. Use !media on to allow media downloads.';
  } else if (media) {
    const size = Number(media.data.fileLength || 0);
    if (size && size > MAX_MB * 1024 * 1024) {
      a.note = `Media larger than ${MAX_MB} MB was not saved`;
    } else {
      try {
        const buf = await downloadMediaMessage(msg,'buffer',{},{
          logger, reuploadRequest: sock.updateMediaMessage
        });
        const filename = `${id.replace(/[^a-zA-Z0-9_-]/g,'_')}.${ext(media.type,media.data.mimetype || '')}`;
        const file = path.join(MEDIA, filename);
        fs.writeFileSync(file, buf);
        a.mediaType = media.type;
        a.file = file;
        a.caption = media.data.caption || '';
      } catch (e) { a.note = `Media save failed: ${e.message}`; }
    }
  }
  archive.push(a);
  if (archive.length > 5000) archive = archive.slice(-5000);
  save();
}

async function alertDeleted(keys) {
  for (const k of keys || []) {
    const a = archive.find(x => x.id === k.id && x.jid === k.remoteJid);
    if (!a) continue;
    a.deleted = true;
    save();
    const when = new Date(a.time * 1000).toLocaleString('en-GB', {timeZone:'Africa/Dar_es_Salaam'});
    await sockRef.sendMessage(OWNER_JID, {
      text: '🛡️ Anti-delete archive notice\nChat: ' + a.jid + '\nSender: ' + a.sender + '\nTime: ' + when + '\nID: ' + a.id + '\nText: ' + (a.text || '(no text)') + '\nSaved media: ' + (a.file || '(none)') + '\nUse !get ' + a.id + ' to retrieve.'
    }).catch(() => {});
  }
}

async function aiReply(jid, prompt, imageUrl) {
  const old = chats.get(jid) || [];
  const content = [];
  if (prompt) content.push({type:'text', text:prompt});
  if (imageUrl) {
    if (!prompt) content.push({type:'text', text:'Describe this image.'});
    content.push({type:'image_url', image_url:{url:imageUrl}});
  }
  if (!KEY) throw new Error('OpenRouter API key is missing.');
  const messages = [
    {role:'system', content:'You are ' + BOT + ', a friendly assistant. Reply in English or Kiswahili according to the user language. Be accurate, concise and respectful. For images, describe visible content; do not identify people or infer sensitive traits.'},
    ...old,
    {role:'user', content}
  ];
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{Authorization:'Bearer ' + KEY, 'Content-Type':'application/json', 'X-OpenRouter-Title':'OBS MD'},
    body:JSON.stringify({model:MODEL, messages, max_tokens:600})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'OpenRouter API error ' + r.status);
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('Empty or unsupported AI response');
  chats.set(jid, [...old, {role:'user',content:prompt || '[image]'}, {role:'assistant',content:answer.trim()}].slice(-10));
  return answer.trim();
}

function mentions(msg) {
  return unwrap(msg).extendedTextMessage?.contextInfo?.mentionedJid || [];
}
async function checkAdmins(sock,jid,sender) {
  if (!group(jid)) throw new Error('Use this inside a group.');
  if (!owner(sender)) throw new Error('Owner only.');
  const md = await sock.groupMetadata(jid);
  const botNum = digits(sock.user?.id);
  const op = md.participants.find(p => digits(p.id) === OWNER);
  const bp = md.participants.find(p => digits(p.id) === botNum);
  if (!op || !['admin','superadmin'].includes(op.admin)) throw new Error('Owner must be a group admin.');
  if (!bp || !['admin','superadmin'].includes(bp.admin)) throw new Error('Bot must be a group admin.');
  return md;
}
async function sendSaved(sock,a) {
  if (a.file && fs.existsSync(a.file)) {
    const caption = `Saved archive ${a.id}\nChat: ${a.jid}\nSender: ${a.sender}`;
    if (a.mediaType === 'imageMessage') await sock.sendMessage(OWNER_JID,{image:{url:a.file},caption});
    else if (a.mediaType === 'videoMessage') await sock.sendMessage(OWNER_JID,{video:{url:a.file},caption});
    else if (a.mediaType === 'audioMessage') await sock.sendMessage(OWNER_JID,{audio:{url:a.file},mimetype:'audio/ogg'});
    else if (a.mediaType === 'stickerMessage') await sock.sendMessage(OWNER_JID,{sticker:{url:a.file}});
    else await sock.sendMessage(OWNER_JID,{document:{url:a.file},fileName:path.basename(a.file),caption});
  } else {
    await sock.sendMessage(OWNER_JID,{text:`${a.id}\n${a.jid}\n${a.sender}\n${a.text || '(no text)'}\n${a.note || ''}`});
  }
}

async function command(sock,msg,t) {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || jid;
  const s = t.toLowerCase();

  // OBS MD Owner Control Panel.
  if (['!panel', '!status', '!diagnostics'].includes(s)) {
    if (!owner(sender)) {
      await sock.sendMessage(jid, {text:'⛔ Owner only.'});
      return true;
    }

    const seconds = Math.floor(process.uptime());
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const uptime = days + 'd ' + hours + 'h ' + minutes + 'm';
    const memory = process.memoryUsage();
    const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
    const connection = sock.user?.id ? 'Connected' : 'Not confirmed';

    if (s === '!panel') {
      await sock.sendMessage(jid, {text:[
        '╔══════ OBS MD ══════╗',
        '       OWNER PANEL',
        '╚═══════════════════╝',
        '',
        '🤖 Bot: ' + BOT,
        '📡 WhatsApp: ' + connection,
        '🧠 AI: ' + (settings().ai ? 'ON' : 'OFF'),
        '⚙️ Model: ' + MODEL,
        '⏱️ Uptime: ' + uptime,
        '💾 RAM: ' + mb(memory.rss),
        '',
        '🔐 SECURITY',
        'Anti-spam groups: ' + Object.values(groupData.groups || {}).filter(g => g.antiSpam).length,
        'Registered groups: ' + Object.keys(groupData.groups || {}).length,
        '',
        '⚡ QUICK CONTROLS',
        '!ai on / !ai off',
        '!online on / !online off',
        '!datasaver on / !datasaver off',
        '!media on / !media off',
        '!security',
        '!status',
        '!diagnostics',
        '!help',
        '',
        '🔐 Owner access protected.'
      ].join('\n')});
      return true;
    }

    if (s === '!status') {
      await sock.sendMessage(jid, {text:[
        '📊 OBS MD STATUS',
        'WhatsApp: ' + connection,
        'AI configured: ' + (KEY ? 'Yes' : 'No'),
        'AI auto reply: ' + (AUTO ? 'On' : 'Off'),
        'Model: ' + MODEL,
        'Uptime: ' + uptime,
        'RAM used: ' + mb(memory.rss),
        'Heap used: ' + mb(memory.heapUsed),
        'Node.js: ' + process.version
      ].join('\n')});
      return true;
    }

    const checks = [
      ['index.js', fs.existsSync('./index.js')],
      ['package.json', fs.existsSync('./package.json')],
      ['archive folder', fs.existsSync('./archive')],
      ['WhatsApp session folder', fs.existsSync('./auth_info')],
      ['Group database', fs.existsSync('./group-data.json')]
    ];

    await sock.sendMessage(jid, {text:[
      '🛡️ OBS MD DIAGNOSTICS',
      'Node: ' + process.version,
      'Platform: ' + process.platform,
      'Architecture: ' + process.arch,
      'Uptime: ' + uptime,
      'Memory: ' + mb(memory.rss),
      '',
      ...checks.map(([name, ok]) => (ok ? '✅ ' : '❌ ') + name),
      '',
      'AI key configured: ' + (KEY ? 'Yes' : 'No')
    ].join('\n')});
    return true;
  }


  // OBS MD Smart Group Assistant commands.
  // Group description commands.
  if (s === '!description') {
    if (!group(jid)) {
      await sock.sendMessage(jid, {text:'Use this command inside a group.'});
    } else {
      try {
        const md = await sock.groupMetadata(jid);
        await sock.sendMessage(jid, {
          text: '📝 GROUP DESCRIPTION\\n' + (md.desc || 'No description set.')
        });
      } catch (e) {
        await sock.sendMessage(jid, {text:'Could not read the group description.'});
      }
    }
    return true;
  }

  if (s.startsWith('!setdesc ')) {
    if (!group(jid) || !owner(sender)) {
      await sock.sendMessage(jid, {text:'⛔ Owner-only group command.'});
      return true;
    }

    const description = t.slice(9).trim();

    if (!description || description.length > 500) {
      await sock.sendMessage(jid, {text:'Enter a description (maximum 500 characters).'});
      return true;
    }

    try {
      await checkAdmins(sock, jid, sender);
      await sock.groupUpdateDescription(jid, description);
      await sock.sendMessage(jid, {text:'✅ Group description updated.'});
    } catch (e) {
      await sock.sendMessage(jid, {text:'⚠️ Could not update description: ' + e.message});
    }
    return true;
  }


  if (s === '!security') {
    if (!owner(sender)) {
      await sock.sendMessage(jid,{text:'⛔ Owner only.'});
      return true;
    }

    const groups = Object.entries(groupData.groups || {});
    let warnings = 0;
    let protectedGroups = 0;

    for (const [,g] of groups) {
      warnings += Object.values(g.warnings || {}).reduce((a,n) => a + Number(n || 0), 0);
      if (g.antiSpam) protectedGroups++;
    }

    await sock.sendMessage(jid,{text:[
      '🔐 OBS MD SECURITY CENTRE',
      '',
      'Groups registered: ' + groups.length,
      'Anti-spam enabled: ' + protectedGroups,
      'Anti-spam disabled: ' + (groups.length - protectedGroups),
      'Total warnings: ' + warnings,
      'AI enabled: ' + (settings().ai ? 'Yes' : 'No'),
      '',
      'GROUP SECURITY COMMANDS',
      '!antispam on',
      '!antispam off',
      '!warnings',
      '!groupstats',
      '',
      'Owner protection: Active'
    ].join('\n')});
    return true;
  }

  if (s === '!rules') {
    if (!group(jid)) {
      await sock.sendMessage(jid, {text:'Use !rules inside a group.'});
    } else {
      await sock.sendMessage(jid, {text:'📜 GROUP RULES\n' + groupRecord(jid).rules});
    }
    return true;
  }

  if (/^!(welcome|antispam)\s+(on|off)$/.test(s)) {
    if (!group(jid) || !owner(sender)) {
      await sock.sendMessage(jid,{text:'⛔ Owner-only group command.'});
      return true;
    }
    const [, action, value] = s.match(/^!(welcome|antispam)\s+(on|off)$/);
    const g = groupRecord(jid);
    g[action === 'welcome' ? 'welcome' : 'antiSpam'] = value === 'on';
    saveGroupData();
    await sock.sendMessage(jid,{text:'✅ ' + action + ' ' + value});
    return true;
  }

  if (s.startsWith('!setrules ')) {
    if (!group(jid) || !owner(sender)) {
      await sock.sendMessage(jid,{text:'⛔ Owner-only group command.'});
      return true;
    }
    const rules = t.slice(9).trim();
    if (!rules || rules.length > 1500) {
      await sock.sendMessage(jid,{text:'Provide group rules (maximum 1500 characters).'});
    } else {
      groupRecord(jid).rules = rules;
      saveGroupData();
      await sock.sendMessage(jid,{text:'✅ Group rules updated. Members can use !rules.'});
    }
    return true;
  }

  if (s === '!warnings') {
    if (!group(jid) || !owner(sender)) {
      await sock.sendMessage(jid,{text:'⛔ Owner-only group command.'});
      return true;
    }
    const rows = Object.entries(groupRecord(jid).warnings);
    await sock.sendMessage(jid,{text:rows.length
      ? '⚠️ GROUP WARNINGS\\n' + rows.map(([user,n]) => user + ': ' + n).join('\\n')
      : 'No member warnings recorded.'});
    return true;
  }

  if (s === '!groupstats') {
    if (!group(jid) || !owner(sender)) {
      await sock.sendMessage(jid,{text:'⛔ Owner-only group command.'});
      return true;
    }
    const g = groupRecord(jid);
    await sock.sendMessage(jid,{text:
      '📊 OBS MD GROUP REPORT\\nMessages: ' + g.messages +
      '\\nMembers joined: ' + g.joins +
      '\\nMembers left: ' + g.leaves +
      '\\nWelcome: ' + (g.welcome ? 'ON' : 'OFF') +
      '\\nAnti-spam: ' + (g.antiSpam ? 'ON' : 'OFF')});
    return true;
  }

  if (s.startsWith('!warn')) {
    if (!group(jid) || !owner(sender)) {
      await sock.sendMessage(jid,{text:'⛔ Owner-only group command.'});
      return true;
    }
    const targets = mentions(msg);
    if (!targets.length) {
      await sock.sendMessage(jid,{text:'Mention a member: !warn @member'});
    } else {
      const g = groupRecord(jid);
      for (const target of targets) {
        g.warnings[target] = (g.warnings[target] || 0) + 1;
      }
      saveGroupData();
      await sock.sendMessage(jid,{text:'⚠️ Warning recorded for ' + targets.length + ' member(s).'});
    }
    return true;
  }

  // Convert an image captioned !sticker into a WhatsApp WebP sticker.
  if (s === '!sticker') {
    const media = mediaOf(unwrap(msg));

    if (!media || media.type !== 'imageMessage') {
      await sock.sendMessage(jid, {
        text: '🖼️ Send an image with the caption !sticker.'
      }, {quoted:msg});
      return true;
    }

    const size = Number(media.data.fileLength || 0);
    if (size > MAX_MB * 1024 * 1024) {
      await sock.sendMessage(jid, {
        text: '⚠️ Image exceeds the ' + MAX_MB + ' MB limit.'
      }, {quoted:msg});
      return true;
    }

    try {
      await sock.sendPresenceUpdate('composing', jid);
      const input = await downloadMediaMessage(
        msg, 'buffer', {}, {logger, reuploadRequest:sock.updateMediaMessage}
      );

      const sticker = await sharp(input)
        .rotate()
        .resize(512, 512, {
          fit: 'contain',
          background: {r:0, g:0, b:0, alpha:0}
        })
        .webp({quality:75, effort:6})
        .toBuffer();

      await sock.sendMessage(jid, {sticker}, {quoted:msg});
    } catch (e) {
      console.error('[OBS MD sticker]', e);
      await sock.sendMessage(jid, {
        text: '⚠️ Sticker creation failed. Please try another image.'
      }, {quoted:msg});
    } finally {
      await sock.sendPresenceUpdate('paused', jid).catch(()=>{});
    }

    return true;
  }


  if (['!help','!ping','!time','!about'].includes(s)) {
    const replies = {
      '!help': `🤖 ${BOT}\n\nAI: send a private message or image.\n!help !ping !time !about !reset\n\nOwner only:\n!find WORD\n!recent\n!get ID\n!groups\n!members (in group)\n!kick @mention\n!promote @mention\n!demote @mention\n!ai on/off\n!online on/off\n!datasaver on/off\n!media on/off\n\nSmart Group Assistant:\n!rules\n!description\n!setrules TEXT (owner)\n!setdesc TEXT (owner)\n!welcome on/off (owner)\n!antispam on/off (owner)\n!warnings (owner)\n!warn @member (owner)\n!groupstats (owner)`,
      '!ping':'🏓 Bot is online / Nipo hewani.',
      '!time':new Date().toLocaleString('en-GB',{timeZone:'Africa/Dar_es_Salaam'})+' EAT',
      '!about':`${BOT}: bilingual AI assistant, message/media archive and owner-only group tools.`
    };
    await sock.sendMessage(jid,{text:replies[s]}); return true;
  }
  if (s === '!reset') { chats.delete(jid); await sock.sendMessage(jid,{text:'Chat memory cleared / Kumbukumbu zimefutwa.'}); return true; }

  const ownerOnly = /^!(find|recent|get|groups|members|kick|promote|demote|ai|online|datasaver|media)\b/i.test(t);
  if (ownerOnly && !owner(sender)) {
    await sock.sendMessage(jid,{text:'⛔ Owner-only command / Amri ya mmiliki pekee.'}); return true;
  }
  if (/^!(ai|online|datasaver|media)\s/.test(s)) {
    const [cmd,val] = s.split(/\s+/);
    if (!['on','off'].includes(val)) await sock.sendMessage(jid,{text:`Use ${cmd} on or ${cmd} off`});
    else {
      const old = settings();
      const key = ({'!ai':'ai','!online':'online','!datasaver':'dataSaver','!media':'mediaDownloads'})[cmd];
      old[key] = val === 'on'; setSettings(old);
      const extra = cmd === '!datasaver' && val === 'on' ? '\nMedia downloads remain disabled. Use !media on only when needed.' : '';
      await sock.sendMessage(jid,{text:`${cmd.slice(1)} ${val}.${extra}`});
    }
    return true;
  }
  if (s.startsWith('!find ')) {
    const q = s.slice(6);
    const found = archive.filter(a => (a.text+' '+(a.caption||'')).toLowerCase().includes(q)).slice(-10).reverse();
    await sock.sendMessage(OWNER_JID,{text:found.length ? found.map(a=>`${a.id} | ${a.deleted?'deleted':'saved'} | ${a.text || a.caption || a.mediaType || 'media'}`).join('\n') : 'No archive matches.'});
    return true;
  }
  if (s === '!recent') {
    const rows = archive.slice(-10).reverse();
    await sock.sendMessage(OWNER_JID,{text:rows.length ? rows.map(a=>`${a.id} | ${a.text || a.caption || a.mediaType || 'media'}`).join('\n') : 'Archive is empty.'});
    return true;
  }
  if (s.startsWith('!get ')) {
    const a = archive.find(x=>x.id===t.slice(5).trim());
    if (a) await sendSaved(sock,a); else await sock.sendMessage(OWNER_JID,{text:'Archive ID not found.'});
    return true;
  }
  if (s === '!groups') {
    const groups = await sock.groupFetchAllParticipating();
    await sock.sendMessage(OWNER_JID,{text:Object.values(groups).map(g=>`${g.subject}\n${g.id}`).join('\n\n') || 'No groups.'});
    return true;
  }
  if (s === '!members') {
    try {
      const md = await checkAdmins(sock,jid,sender);
      await sock.sendMessage(OWNER_JID,{text:`${md.subject}\n`+md.participants.map((p,i)=>`${i+1}. ${p.name || p.notify || 'Member'} ${p.admin ? '['+p.admin+']' : ''}`).join('\n')});
    } catch(e) { await sock.sendMessage(jid,{text:e.message}); }
    return true;
  }
  const m = s.match(/^!(kick|promote|demote)\b/);
  if (m) {
    try {
      await checkAdmins(sock,jid,sender);
      const targets = mentions(msg);
      if (!targets.length) throw new Error('Mention a member in the command.');
      await sock.groupParticipantsUpdate(jid,targets,m[1] === 'kick' ? 'remove' : m[1]);
      await sock.sendMessage(jid,{text:`✅ ${m[1]} action requested.`});
    } catch(e) { await sock.sendMessage(jid,{text:`⚠️ ${e.message}`}); }
    return true;
  }
  return false;
}

const groupSpam = new Map();
const spamCooldown = new Map();

async function onMessage(sock,msg,type) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid || '';
  const sender = msg.key.participant || jid;
  const t = textOf(msg);

  // Allow authenticated owner commands from the connected account.
  if (msg.key.fromMe) {
    const selfOwner = owner(jid) &&
      digits(jid) === digits(sock.user?.id);

    if (!selfOwner) return;

    if (t.trim().toLowerCase() === '!test') {
      await sock.sendMessage(jid, {
        text: '✅ OBS MD self-test successful!\nWhatsApp connection: active\nAI service: configured\nTime: ' +
          new Date().toLocaleString('en-GB', {timeZone:'Africa/Dar_es_Salaam'})
      });
      return;
    }

    // Only allow commands from the connected owner account.
    if (!t.trim().startsWith('!')) return;
  }

  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;
  if (msg.key.id && seen.has(msg.key.id)) return;
  if (msg.key.id) { seen.add(msg.key.id); if (seen.size>1000) seen.delete(seen.values().next().value); }
  activeChats.add(jid);

  // OBS MD group activity and anti-spam protection.
  if (group(jid)) {
    const g = groupRecord(jid);
    g.messages = (g.messages || 0) + 1;
    if (g.messages % 10 === 0) saveGroupData();

    if (g.antiSpam && t.trim() && !t.trim().startsWith('!') && !owner(sender)) {
      const now = Date.now();
      const key = jid + ':' + sender;
      const body = t.trim().toLowerCase();
      const history = (groupSpam.get(key) || []).filter(x => now - x.time < 10000);

      history.push({time: now, text: body});
      groupSpam.set(key, history);

      const repeated = history.filter(x => x.text === body).length >= 3;
      const flooding = history.length > 6;
      const cooldown = spamCooldown.get(key) || 0;

      if ((repeated || flooding) && now - cooldown > 60000) {
        spamCooldown.set(key, now);
        g.warnings[sender] = (g.warnings[sender] || 0) + 1;
        saveGroupData();

        await sock.sendMessage(jid, {
          text: '⚠️ @' + sender.split('@')[0] +
            ' OBS MD detected repeated messages. Please slow down. Warning ' +
            g.warnings[sender] + '.',
          mentions: [sender]
        });
        groupSpam.delete(key);
      }
    }
  }

  if (t.startsWith('!') && await command(sock,msg,t)) return;
  if (group(jid)) return; // no unsolicited AI messages in groups
  if (!settings().ai && AUTO) return;
  if (!AUTO && !settings().ai) return;

  const m = unwrap(msg), med = mediaOf(m);
  if (!t && med?.type !== 'imageMessage') return;
  if (med?.type === 'imageMessage' && !settings().mediaDownloads) {
    await sock.sendMessage(jid,{text:'🛡️ OBS MD Data Saver: automatic image analysis is paused to save Airtel data. Send !media on to allow image downloads, then send the image again.'},{quoted:msg});
    return;
  }
  try {
    await sock.sendPresenceUpdate('composing',jid);
    let img;
    if (med?.type === 'imageMessage') {
      const b = await downloadMediaMessage(msg,'buffer',{}, {logger,reuploadRequest:sock.updateMediaMessage});
      img = `data:${med.data.mimetype || 'image/jpeg'};base64,${b.toString('base64')}`;
    }
    const answer = await aiReply(jid,t,img);
    await sock.sendMessage(jid,{text:answer},{quoted:msg});
  } catch(e) {
    console.error(e);
    await sock.sendMessage(jid,{text:'Sorry, I could not process that. Samahani, imeshindikana kuchakata ujumbe.'});
  } finally { await sock.sendPresenceUpdate('paused',jid).catch(()=>{}); }
}

async function start() {
  const {state,saveCreds} = await useMultiFileAuthState('./auth_info');
  const sock = makeWASocket({auth:state,logger,printQRInTerminal:false,syncFullHistory:false,markOnlineOnConnect:false});
  sockRef = sock;
  sock.ev.on('creds.update',saveCreds);
  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async ({connection,lastDisconnect,qr}) => {
    if (qr && !state.creds.registered && OWNER && !pairingCodeRequested) {
      pairingCodeRequested = true;
      try {
        const code = await sock.requestPairingCode(OWNER);
        console.log('OBS MD WhatsApp pairing code:', code);
        console.log('On WhatsApp: Linked devices > Link a device > Link with phone number instead.');
      } catch (err) {
        console.error('Pairing failed:', err?.message || err);
        pairingCodeRequested = false;
      }
    }

    if (connection === 'open') {
      reconnecting = false;
      console.log('✅ OBS MD connected.');
    }

    if (connection === 'close' && !reconnecting) {
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        console.log('WhatsApp session logged out. Pair again.');
        return;
      }
      reconnecting = true;
      setTimeout(() => {
        reconnecting = false;
        start().catch(console.error);
      }, 5000);
    }
  });
  sock.ev.on('messages.upsert', async ({messages, type}) => {
  console.log(`[OBS MD] Incoming event: type=${type}, count=${messages.length}`);

  if (type !== 'notify') return;

  for (const msg of messages) {
    console.log('[OBS MD] Message received:', {
      fromMe: msg.key.fromMe,
      hasMessage: !!msg.message
    });

    await onMessage(sock, msg, type).catch(console.error);
  }
});
  sock.ev.on('messages.delete',async e=>{ if(e?.keys) await alertDeleted(e.keys); });
  sock.ev.on('group-participants.update', async e => {
    try {
      const g = groupRecord(e.id);
      const participants = e.participants || [];

      if (e.action === 'add') {
        g.joins = (g.joins || 0) + participants.length;

        if (g.welcome) {
          for (const user of participants) {
            await sock.sendMessage(e.id, {
              text: '🎉 Welcome to the group! @' + user.split('@')[0] +
                '\nPlease read our group rules by typing !rules.',
              mentions: [user]
            });
          }
        }
      }

      if (e.action === 'remove') {
        g.leaves = (g.leaves || 0) + participants.length;
      }

      saveGroupData();

      await sock.sendMessage(OWNER_JID, {
        text: `Group update\nGroup: ${e.id}\nAction: ${e.action}\nParticipants: ${participants.join(', ')}\nBy: ${e.author || 'unknown'}`
      }).catch(() => {});
    } catch (err) {
      console.error('Group event error:', err.message);
    }
  });
  sock.ev.on('call',async calls=>{
    for (const c of calls||[]) if (c.status==='offer')
      await sock.sendMessage(OWNER_JID,{text:`Incoming ${c.isVideo?'video':'voice'} call: ${c.from||'unknown'}`}).catch(()=>{});
  });


  // Presence is chat-scoped and expires quickly; refresh only for chats the bot has interacted with.
  setInterval(async()=>{
    if (sock.user && settings().online) {
      for (const jid of activeChats) {
        try { await sock.sendPresenceUpdate('available', jid); } catch {}
      }
    }
  },8000);
}
process.on('unhandledRejection',console.error);
start().catch(e=>{console.error(e);process.exit(1);});
