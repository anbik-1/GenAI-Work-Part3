import { APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, CartItem, Order, OrderItem } from '@anycompanyread/shared';
import { docClient } from '../../utils/dynamodb';
import { created, badRequest } from '../../utils/response';
import { randomUUID } from 'crypto';

/**
 * Create an order from the user's cart contents.
 * - Reads cart items
 * - Creates order record
 * - Creates order item records
 * - Clears the cart
 * No real payment processing — order is immediately "CONFIRMED".
 */
export async function checkout(userId: string): Promise<APIGatewayProxyResult> {
  // 1. Get cart items
  const cartResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.CARTS,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    })
  );

  const cartItems = (cartResult.Items || []) as CartItem[];

  if (cartItems.length === 0) {
    return badRequest('Cart is empty. Add items before checking out.');
  }

  // 2. Calculate totals
  const totalPrice = Math.round(
    cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100
  ) / 100;
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  // 3. Create order record
  const orderId = randomUUID();
  const now = new Date().toISOString();

  const order: Order = {
    userId,
    orderId,
    totalPrice,
    status: 'CONFIRMED',
    itemCount,
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.ORDERS,
      Item: order,
    })
  );

  // 4. Create order items (batch write, max 25 items per batch)
  const orderItems: OrderItem[] = cartItems.map((item) => ({
    orderId,
    bookId: item.bookId,
    quantity: item.quantity,
    price: item.price,
    title: item.title,
  }));

  // Write order items in batches of 25
  const batches = [];
  for (let i = 0; i < orderItems.length; i += 25) {
    batches.push(orderItems.slice(i, i + 25));
  }

  for (const batch of batches) {
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAMES.ORDER_ITEMS]: batch.map((item) => ({
            PutRequest: { Item: item },
          })),
        },
      })
    );
  }

  // 5. Clear the cart
  for (const item of cartItems) {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAMES.CARTS,
        Key: { userId, bookId: item.bookId },
      })
    );
  }

  return created({ order: { ...order, items: orderItems } });
}
