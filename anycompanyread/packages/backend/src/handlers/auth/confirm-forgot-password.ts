import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConfirmForgotPasswordRequest } from '@anycompanyread/shared';
import { success, badRequest } from '../../utils/response';

const cognito = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

/**
 * Confirm password reset with verification code and new password.
 */
export async function confirmForgotPassword(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}') as ConfirmForgotPasswordRequest;

  if (!body.email || !body.code || !body.newPassword) {
    return badRequest('Email, code, and newPassword are required');
  }

  await cognito.send(
    new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: body.email,
      ConfirmationCode: body.code,
      Password: body.newPassword,
    })
  );

  return success({ message: 'Password reset successful' });
}
