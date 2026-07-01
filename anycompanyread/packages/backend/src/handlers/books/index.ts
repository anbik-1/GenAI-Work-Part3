import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { listBooks } from './list-books';
import { getBook } from './get-book';
import { badRequest } from '../../utils/response';
import { handleError } from '../../utils/error';

/**
 * Books Lambda handler — routes requests based on method and path.
 * GET /books — list/search books
 * GET /books/{bookId} — get book details
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const method = event.httpMethod;
    const path = event.path;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' }, body: '' };
    }

    if (method === 'GET') {
      // Check if there's a bookId path parameter
      const bookId = event.pathParameters?.bookId;
      if (bookId) {
        return await getBook(event, bookId);
      }
      return await listBooks(event);
    }

    return badRequest(`Unsupported route: ${method} ${path}`);
  } catch (err) {
    return handleError(err);
  }
}
