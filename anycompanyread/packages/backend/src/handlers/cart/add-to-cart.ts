import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, AddToCartRequest, Book } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { created, badRequest, notFound } from '../../utils/response';

/**
 * Add an item to the user's cart.
 * Looks up the book to denormalize title, price, and coverImageUrl.
 * If the item already exists, updates the quantity.
 */
export async function addToCart(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}') as AddToCartRequest;

  if (!body.bookId || !body.quantity || body.quantity < 1) {
    return badRequest('bookId and quantity (>= 1) are required');
  }

  // Look up the book to get denormalized data
  const bookResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.BOOKS,
      Key: { bookId: body.bookId },
    })
  );

  if (!bookResult.Item) {
    return notFound(`Book with id '${body.bookId}' not found`);
  }

  const book = bookResult.Item as Book;

  // Check if item already exists in cart
  const existingItem = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.CARTS,
      Key: { userId, bookId: body.bookId },
    })
  );

  const newQuantity = existingItem.Item
    ? (existingItem.Item.quantity as number) + body.quantity
    : body.quantity;

  const cartItem = {
    userId,
    bookId: body.bookId,
    quantity: newQuantity,
    title: book.title,
    price: book.price,
    coverImageUrl: book.coverImageUrl,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.CARTS,
      Item: cartItem,
    })
  );

  return created({ item: cartItem });
}
