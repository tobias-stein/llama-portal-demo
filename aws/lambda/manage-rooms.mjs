import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

// 1. Read the environment variables injected by CloudFormation
const TABLE_NAME = process.env.TABLE_NAME;
const MANAGE_BOOKINGS_FUNCTION = process.env.MANAGE_BOOKINGS_FUNCTION;

const lambdaClient = new LambdaClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Main Lambda handler function.
 * It routes the request to the appropriate function based on the 'action' field.
 */
export const handler = async (event) => {
  // The 'action' determines which operation to perform
  const { action, room, roomId } = event;

  try {
    switch (action) {
      case "CREATE":
        if (!room) {
          throw new Error("Room data is required for CREATE action.");
        }
        return await createRoom(room);

      case "UPDATE":
        if (!room || !room.id) {
          throw new Error("Room data with an ID is required for UPDATE action.");
        }
        return await updateRoom(room);

      case "DELETE":
        if (!roomId) {
          throw new Error("roomId is required for DELETE action.");
        }
        return await deleteRoom(roomId);

      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ message: `Unknown action: ${action}` }),
        };
    }
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: error.message || "An internal server error occurred." }),
    };
  }
};

/**
 * Creates a new Room item in the DynamoDB table.
 */
async function createRoom(room) {
  const { id, name, capacity } = room;

  const item = {
    PK: `ROOM#${id}`,
    SK: `ROOM#${id}`,
    id: id,
    name: name,
    capacity: parseInt(capacity, 10),
    entity: "Room",
    GSI1PK: "ROOMS",
    GSI1SK: `ROOM#${name}`,
  };

  const command = new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(PK)",
  });

  try {
    await docClient.send(command);
    console.log(`Successfully created room with ID: ${id}`);
    return {
      statusCode: 201,
      body: JSON.stringify(item),
    };
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.error(`Error: Room with ID ${id} already exists.`);
      throw new Error(`Room with ID ${id} already exists.`);
    }
    throw error;
  }
}

/**
 * Updates an existing Room item's name and capacity.
 */
async function updateRoom(room) {
  const { id, name, capacity } = room;

  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: `ROOM#${id}`,
      SK: `ROOM#${id}`,
    },
    UpdateExpression: "SET #name = :name, GSI1SK = :gsi1sk",
    ExpressionAttributeNames: {
      "#name": "name",
    },
    ExpressionAttributeValues: {
      ":name": name,
      ":gsi1sk": `ROOM#${name}`,
    },
    ConditionExpression: "attribute_exists(PK)",
    ReturnValues: "ALL_NEW",
  });

  try {
    const { Attributes } = await docClient.send(command);
    console.log(`Successfully updated room with ID: ${id}`);
    return {
      statusCode: 200,
      body: JSON.stringify(Attributes),
    };
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.error(`Error: Room with ID ${id} not found.`);
      throw new Error(`Room with ID ${id} not found.`);
    }
    throw error;
  }
}

/**
 * Deletes a Room item from the DynamoDB table and cancels all associated bookings.
 */
async function deleteRoom(roomId) {
  try {
    // 1. Query the table to find all items with this Room's PK
    // This will return the Room entity itself AND all of its Allocation items.
    const queryCommand = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `ROOM#${roomId}`,
      },
    });

    const queryResults = await docClient.send(queryCommand);

    // 2. Extract unique booking IDs from the room's allocations
    const bookingIdsToCancel = new Set();
    if (queryResults.Items) {
      for (const item of queryResults.Items) {
        if (item.entity === "Allocation" && item.bookingId) {
          bookingIdsToCancel.add(item.bookingId);
        }
      }
    }

    // 3. Invoke the `manage-bookings` Lambda to cancel all affected bookings
    if (bookingIdsToCancel.size > 0) {
      console.log(`Found ${bookingIdsToCancel.size} bookings to cancel for room ${roomId}.`);

      const cancelPromises = Array.from(bookingIdsToCancel).map(async (bookingId) => {
        const payload = {
          action: "CANCEL",
          bookingId: bookingId
        };

        const invokeCommand = new InvokeCommand({
          FunctionName: MANAGE_BOOKINGS_FUNCTION, // <-- Use the ENV variable here
          Payload: new TextEncoder().encode(JSON.stringify(payload)),
        });

        try {
          const response = await lambdaClient.send(invokeCommand);
          const responsePayload = new TextDecoder().decode(response.Payload);
          
          if (response.FunctionError) {
            console.error(`Lambda Error cancelling booking ${bookingId}:`, responsePayload);
          } else {
            console.log(`Successfully invoked cancellation for booking ${bookingId}.`);
          }
        } catch (invokeErr) {
          console.error(`Network/SDK Error invoking manage-bookings for ${bookingId}:`, invokeErr);
        }
      });

      // Execute all cancellations concurrently and wait for them to finish
      await Promise.all(cancelPromises);
    }

    // 4. Finally, delete the Room entity itself
    const deleteCommand = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `ROOM#${roomId}`,
        SK: `ROOM#${roomId}`,
      },
      ConditionExpression: "attribute_exists(PK)",
    });

    await docClient.send(deleteCommand);
    console.log(`Successfully deleted room with ID: ${roomId}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Room ${roomId} and its associated bookings deleted successfully.` }),
    };

  } catch (error) {
     if (error.name === 'ConditionalCheckFailedException') {
      console.error(`Error: Room with ID ${roomId} not found for deletion.`);
      throw new Error(`Room with ID ${roomId} not found.`);
    }
    throw error;
  }
}