import { APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, Order, OrderItem } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success, notFound, unauthorized } from '../../utils/response';

/**
 * Get order details including items.
 * Validates the order belongs to the authenticated user.
 */
export async function getOrder(userId: string, orderId: string): Promise<APIGatewayProxyResult> {
  // Get the order record
  const orderResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.ORDERS,
      Key: { userId, orderId },
    })
  );

  if (!orderResult.Item) {
    return notFound(`Order '${orderId}' not found`);
  }

  const order = orderResult.Item as Order;

  // Verify ownership
  if (order.userId !== userId) {
    return unauthorized('You do not have access to this order');
  }

  // Get order items
  const itemsResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.ORDER_ITEMS,
      KeyConditionExpression: 'orderId = :orderId',
      ExpressionAttributeValues: {
        ':orderId': orderId,
      },
    })
  );

  const items = (itemsResult.Items || []) as OrderItem[];

  return success({ order: { ...order, items } });
}
