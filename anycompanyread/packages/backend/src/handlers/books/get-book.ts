import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, Book } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success, notFound } from '../../utils/response';

/**
 * Get a single book by its bookId.
 */
export async function getBook(event: APIGatewayProxyEvent, bookId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.BOOKS,
      Key: { bookId },
    })
  );

  if (!result.Item) {
    return notFound(`Book with id '${bookId}' not found`);
  }

  return success({ book: result.Item as Book });
}
