export async function readStdinIfPiped(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<Buffer | undefined> {
  if ((stream as NodeJS.ReadStream).isTTY === true) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  return buffer.length === 0 ? undefined : buffer;
}
