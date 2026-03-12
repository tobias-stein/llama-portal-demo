import os
import boto3
import json
import time
from botocore.exceptions import ClientError
from datetime import datetime, timedelta

TABLE_NAME = os.environ.get('TABLE_NAME', 'LlamaBookings')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

def lambda_handler(event, context):
    try:
        # Handle both direct invocation payloads and API Gateway proxies
        body = event
        if 'body' in event and isinstance(event['body'], str):
            body = json.loads(event['body'])

        action = body.get('action')
        booking_id = body.get('bookingId')

        if not action or not booking_id:
            raise ValueError("Missing 'action' or 'bookingId'")

        # 1. Fetch the main booking item first (to ensure it exists)
        booking_key = {'PK': f'BOOKING#{booking_id}', 'SK': 'META'}
        response = table.get_item(Key=booking_key)
        booking = response.get('Item')

        if not booking:
            raise ValueError(f"Booking {booking_id} not found.")

        # ==========================================
        # ACTION: ACCEPT
        # ==========================================
        if action == 'ACCEPT':
            # Update the status to CONFIRMED
            table.update_item(
                Key=booking_key,
                UpdateExpression="SET #s = :s",
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={':s': 'CONFIRMED'}
            )

        # ==========================================
        # ACTION: REJECT or CANCEL
        # ==========================================
        elif action in ['REJECT', 'CANCEL']:
            # 1. Query GSI1 to find all room Allocation items associated with this booking
            alloc_response = table.query(
                IndexName='GSI1',
                KeyConditionExpression='GSI1PK = :pk',
                ExpressionAttributeValues={':pk': f'BOOKING#{booking_id}'}
            )
            allocations = alloc_response.get('Items',[])

            # 2. Batch delete room allocations immediately to free up the rooms
            if allocations:
                with table.batch_writer() as batch:
                    for alloc in allocations:
                        batch.delete_item(Key={
                            'PK': alloc['PK'],
                            'SK': alloc['SK']
                        })
            
            # 3. Determine the new status based on the action
            new_status = 'REJECTED' if action == 'REJECT' else 'CANCELED'
            
            # 4. Calculate the TTL for 14 days from now (as a Unix timestamp)
            ttl_timestamp = int(time.time()) + (14 * 24 * 60 * 60)

            # 5. Update the main booking item with the new status and TTL
            table.update_item(
                Key=booking_key,
                UpdateExpression="SET #s = :s, #ttl = :ttl",
                ExpressionAttributeNames={
                    '#s': 'status',
                    '#ttl': 'ttl'
                },
                ExpressionAttributeValues={
                    ':s': new_status,
                    ':ttl': ttl_timestamp
                }
            )

        else:
            raise ValueError(f"Invalid action: {action}")

        return {
            "statusCode": 200,
            "body": json.dumps({"message": f"Successfully processed {action} for {booking_id}"})
        }

    except Exception as e:
        print(f"Error processing booking: {str(e)}")
        return {
            "statusCode": 400,
            "body": json.dumps({"error": str(e)})
        }