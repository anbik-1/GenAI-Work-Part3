import { APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, Order } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success } from '../../utils/response';

/**
 * List all orders for the authenticated user.
 * Returns orders sorted by creation date (most recent first).
 */
export async function listOrders(userId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.ORDERS,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ScanIndexForward: false, // Most recent first
    })
  );

  const orders = (result.Items || []) as Order[];

  return success({ orders });
}
