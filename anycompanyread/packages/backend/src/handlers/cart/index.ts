import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getCart } from './get-cart';
import { addToCart } from './add-to-cart';
import { updateCartItem } from './update-cart-item';
import { removeFromCart } from './remove-from-cart';
import { badRequest, unauthorized } from '../../utils/response';
import { getUserId } from '../../utils/auth';
import { handleError } from '../../utils/error';

/**
 * Cart Lambda handler — routes requests based on method and path.
 * All cart operations require authentication.
 * GET /cart — get user's cart
 * POST /cart — add item to cart
 * PUT /cart/{bookId} — update item quantity
 * DELETE /cart/{bookId} — remove item from cart
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const method = event.httpMethod;
    const path = event.path;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' }, body: '' };
    }

    // Extract authenticated user ID
    const userId = getUserId(event);
    if (!userId) {
      return unauthorized('Authentication required');
    }

    const bookId = event.pathParameters?.bookId;

    switch (method) {
      case 'GET':
        return await getCart(userId);
      case 'POST':
        return await addToCart(event, userId);
      case 'PUT':
        if (!bookId) return badRequest('bookId path parameter is required');
        return await updateCartItem(event, userId, bookId);
      case 'DELETE':
        if (!bookId) return badRequest('bookId path parameter is required');
        return await removeFromCart(userId, bookId);
      default:
        return badRequest(`Unsupported route: ${method} ${path}`);
    }
  } catch (err) {
    return handleError(err);
  }
}
