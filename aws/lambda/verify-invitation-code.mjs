// verify-auth-challenge/index.mjs
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME || "LlamaBookings"; // Injected via CloudFormation template
const PK_PREFIX  = "INVITATION_CODE#";
const SK         = "METADATA";

// Normalise input so "a3kp9xmz7wqr", "a3kp 9xmz 7wqr", "A3KP-9XMZ-7WQR" all resolve correctly
function normaliseCode(raw) {
  const clean = raw.toUpperCase().replace(/[\s-]/g, '');       // strip spaces/dashes, uppercase
  if (clean.length !== 12) return null;                         // wrong length — reject early
  return `${clean.slice(0,4)}-${clean.slice(4,8)}-${clean.slice(8,12)}`; // re-add dashes
}

export const handler = async (event) => {
  const raw  = event.request.challengeAnswer;
  const code = normaliseCode(raw);
  const now  = Math.floor(Date.now() / 1000);

  event.response.answerCorrect = false;

  if (!code) return event; // wrong length after normalisation

  try {
    const { Item } = await dynamo.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `${PK_PREFIX}${code}` },
        SK: { S: SK },
      },
    }));

    if (!Item) return event; // code doesn't exist

    const used = Item.used.BOOL;
    const ttl  = Number(Item.ttl.N);

    // TTL deletion is eventual — manual check is the hard gate
    if (used || ttl < now) return event;

    // Mark as used atomically — blocks replay attacks
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `${PK_PREFIX}${code}` },
        SK: { S: SK },
      },
      UpdateExpression: "SET used = :true",
      ConditionExpression: "used = :false",
      ExpressionAttributeValues: {
        ":true":  { BOOL: true },
        ":false": { BOOL: false },
      },
    }));

    event.response.answerCorrect = true;

  } catch (err) {
    // ConditionalCheckFailedException → concurrent replay attempt
    console.error(err.name, err.message);
  }

  return event;
};