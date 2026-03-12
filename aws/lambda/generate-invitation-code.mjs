// generate-magic-link/index.mjs
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "crypto";

const dynamo = new DynamoDBClient({});

const TABLE_NAME  = process.env.TABLE_NAME;
const TTL_DAYS    = 7;
const PK_PREFIX   = "INVITATION_CODE#";
const SK          = "METADATA";

// Unambiguous alphabet — no 0/O, 1/I/L to avoid read/type confusion
// 32 chars → 32^12 ≈ 1.2 quintillion combinations for a 3×4 group code
const ALPHABET    = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP_SIZE  = 4;
const GROUP_COUNT = 3; // result: A3KP-9XMZ-7WQR

function generateCode() {
  const totalChars = GROUP_SIZE * GROUP_COUNT;
  const bytes = randomBytes(totalChars);
  const chars = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]);
  const groups = [];
  for (let i = 0; i < GROUP_COUNT; i++) {
    groups.push(chars.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE).join(''));
  }
  return groups.join('-'); // e.g. "A3KP-9XMZ-7WQR"
}

export const handler = async (event) => {
  const code = generateCode();
  const pk   = `${PK_PREFIX}${code}`;
  const ttl  = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * TTL_DAYS;

  await dynamo.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:   { S: pk },
      SK:   { S: SK },
      code: { S: code },
      used: { BOOL: false },
      ttl:  { N: String(ttl) },
    },
    ConditionExpression: "attribute_not_exists(PK)",
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ code }), // e.g. { "code": "A3KP-9XMZ-7WQR" }
  };
};