import { APIGatewayProxyResult } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success } from '../../utils/response';

/**
 * Remove an item from the user's cart.
 */
export async function removeFromCart(userId: string, bookId: string): Promise<APIGatewayProxyResult> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAMES.CARTS,
      Key: { userId, bookId },
    })
  );

  return success({ message: 'Item removed from cart' });
}
