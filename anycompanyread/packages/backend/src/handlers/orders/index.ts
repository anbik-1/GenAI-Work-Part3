import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { checkout } from './checkout';
import { listOrders } from './list-orders';
import { getOrder } from './get-order';
import { badRequest, unauthorized } from '../../utils/response';
import { getUserId } from '../../utils/auth';
import { handleError } from '../../utils/error';

/**
 * Orders Lambda handler — routes requests based on method and path.
 * All order operations require authentication.
 * POST /checkout — create order from cart
 * GET /orders — list user's orders
 * GET /orders/{orderId} — get order details
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

    if (method === 'POST' && path.endsWith('/checkout')) {
      return await checkout(userId);
    }

    if (method === 'GET') {
      const orderId = event.pathParameters?.orderId;
      if (orderId) {
        return await getOrder(userId, orderId);
      }
      return await listOrders(userId);
    }

    return badRequest(`Unsupported route: ${method} ${path}`);
  } catch (err) {
    return handleError(err);
  }
}
