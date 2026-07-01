import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, UpdateCartItemRequest } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success, badRequest } from '../../utils/response';

/**
 * Update the quantity of an item in the user's cart.
 */
export async function updateCartItem(
  event: APIGatewayProxyEvent,
  userId: string,
  bookId: string
): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}') as UpdateCartItemRequest;

  if (!body.quantity || body.quantity < 1) {
    return badRequest('quantity (>= 1) is required');
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.CARTS,
      Key: { userId, bookId },
      UpdateExpression: 'SET quantity = :quantity',
      ExpressionAttributeValues: {
        ':quantity': body.quantity,
      },
      ConditionExpression: 'attribute_exists(userId)',
      ReturnValues: 'ALL_NEW',
    })
  );

  return success({ item: result.Attributes });
}
