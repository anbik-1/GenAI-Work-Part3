import { APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, CartItem } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success } from '../../utils/response';

/**
 * Get all cart items for the authenticated user.
 * Returns items with computed totalPrice and itemCount.
 */
export async function getCart(userId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.CARTS,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    })
  );

  const items = (result.Items || []) as CartItem[];

  const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return success({
    items,
    totalPrice: Math.round(totalPrice * 100) / 100,
    itemCount,
  });
}
