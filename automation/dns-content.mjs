// CF uses RFC 1035 presentation strings; DNS resolver APIs return their decoded content.
export function txtValue(content) {
  if (typeof content !== 'string' || content.length > 65535) throw new Error('Invalid TXT record content.');
  const input = content.trim();
  if (!input.startsWith('"')) {
    if (input.includes('"')) throw new Error('Invalid TXT quoting.');
    return input;
  }
  let position = 0;
  let output = '';
  while (position < input.length) {
    while (/\s/.test(input[position] || '') && position < input.length) position++;
    if (position === input.length) break;
    if (input[position++] !== '"') throw new Error('Invalid TXT quoting.');
    let closed = false;
    while (position < input.length) {
      const character = input[position++];
      if (character === '"') { closed = true; break; }
      if (character !== '\\') { output += character; continue; }
      if (position >= input.length) throw new Error('Invalid TXT escape.');
      const digits = input.slice(position, position + 3);
      if (/^[0-9]{3}$/.test(digits)) {
        const byte = Number(digits);
        if (byte > 255) throw new Error('Invalid TXT byte escape.');
        output += String.fromCharCode(byte);
        position += 3;
      } else {
        output += input[position++];
      }
    }
    if (!closed || (position < input.length && !/\s/.test(input[position]))) throw new Error('Invalid TXT quoting.');
  }
  return output;
}

export function txtPresentation(content) {
  if (typeof content !== 'string' || content.length > 65535) throw new Error('Invalid TXT record content.');
  const value = content;
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error('Email authentication TXT content must be printable ASCII.');
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += 255) chunks.push(JSON.stringify(value.slice(offset, offset + 255)));
  return chunks.join(' ') || '""';
}
