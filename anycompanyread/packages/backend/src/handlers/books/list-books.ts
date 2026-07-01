import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, Book } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { success } from '../../utils/response';

/**
 * List books with optional search (title/author), genre filter, and pagination.
 * Uses DynamoDB Scan with filter expressions for demo simplicity.
 */
export async function listBooks(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const params = event.queryStringParameters || {};
  const search = params.search?.toLowerCase();
  const genre = params.genre;
  const limit = Math.min(parseInt(params.limit || '20', 10), 50);
  const nextToken = params.nextToken;

  // Build filter expressions
  const filterExpressions: string[] = [];
  const expressionValues: Record<string, unknown> = {};
  const expressionNames: Record<string, string> = {};

  if (genre) {
    filterExpressions.push('#genre = :genre');
    expressionValues[':genre'] = genre;
    expressionNames['#genre'] = 'genre';
  }

  // Scan with optional filter
  const scanParams: Record<string, unknown> = {
    TableName: TABLE_NAMES.BOOKS,
    Limit: limit,
  };

  if (filterExpressions.length > 0) {
    (scanParams as any).FilterExpression = filterExpressions.join(' AND ');
    (scanParams as any).ExpressionAttributeValues = expressionValues;
    (scanParams as any).ExpressionAttributeNames = expressionNames;
  }

  if (nextToken) {
    (scanParams as any).ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
  }

  const result = await docClient.send(new ScanCommand(scanParams as any));
  let books = (result.Items || []) as Book[];

  // Client-side search filtering (title/author) for demo simplicity
  if (search) {
    books = books.filter(
      (book) =>
        book.title.toLowerCase().includes(search) ||
        book.author.toLowerCase().includes(search)
    );
  }

  // Encode LastEvaluatedKey as nextToken for pagination
  const responseNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

  return success({
    books,
    totalCount: books.length,
    nextToken: responseNextToken,
  });
}
