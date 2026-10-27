import { Resolver } from 'node:dns/promises';
import { txtValue } from './dns-content.mjs';

const canonical = name => name.toLowerCase().replace(/\.$/, '');

export async function verifyPublicDNS(records, {
  resolvers = ['1.1.1.1', '8.8.8.8'].map(server => {
    const resolver = new Resolver({ timeout: 5000, tries: 1 });
    resolver.setServers([server]);
    return resolver;
  }),
  attempts = 30,
  wait = () => new Promise(resolve => setTimeout(resolve, 10000))
} = {}) {
  if (!records.length || !resolvers.length || attempts < 1) throw new Error('DNS verification requires records and public resolvers.');
  const groups = new Map();
  for (const record of records) {
    if (!['MX', 'TXT'].includes(record.type)) throw new Error('Unsupported verification record type.');
    const key = `${record.type} ${canonical(record.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record.type === 'TXT' ? { ...record, content: txtValue(record.content) } : record);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    let ready = true;
    for (const resolver of resolvers) {
      for (const desired of groups.values()) {
        const { name, type } = desired[0];
        try {
          if (type === 'MX') {
            const answers = await resolver.resolveMx(name);
            if (answers.length !== desired.length || !desired.every(record => answers.some(answer =>
              canonical(answer.exchange) === canonical(record.content) && answer.priority === record.priority))) ready = false;
          } else {
            const answers = (await resolver.resolveTxt(name)).map(chunks => chunks.join(''));
            if (!desired.every(record => answers.includes(record.content))) ready = false;
            const spf = desired.find(record => /^v=spf1\b/i.test(record.content));
            const dmarc = desired.find(record => /^v=DMARC1;/i.test(record.content));
            if (spf && answers.filter(content => /^v=spf1\b/i.test(content)).length !== 1) ready = false;
            if (dmarc && answers.filter(content => /^v=DMARC1;/i.test(content)).length !== 1) ready = false;
          }
        } catch {
          ready = false;
        }
      }
    }
    if (ready) return;
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error('Public MX/SPF/DKIM/DMARC is not ready or conflicts with the expected records. Re-run this same workflow after DNS propagation.');
}
