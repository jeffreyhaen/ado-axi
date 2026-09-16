import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base";
import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";

export const ENCODINGS = {
  o200k_base: encodeO200k,
  cl100k_base: encodeCl100k,
};

export const DEFAULT_ENCODING = "o200k_base";

export function countTokens(text, encoding = DEFAULT_ENCODING) {
  if (!text) return 0;
  const encoder = ENCODINGS[encoding];
  if (!encoder) throw new Error(`unknown encoding: ${encoding}`);
  return encoder(text).length;
}

export function countAll(text) {
  const counts = {};
  for (const name of Object.keys(ENCODINGS)) counts[name] = countTokens(text, name);
  return counts;
}
