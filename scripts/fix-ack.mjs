import fs from 'node:fs';

const file = new URL('../node_modules/baileys/lib/Socket/messages-recv.js', import.meta.url);
const path = file.pathname.replace(/^\/(.:)/, '$1');
let text = fs.readFileSync(path, 'utf8');
text = text.replaceAll('authState.creds.me.id', 'authState.creds.me?.id');
fs.writeFileSync(path, text);
console.log('Baileys pre-login ACK compatibility patch applied.');
