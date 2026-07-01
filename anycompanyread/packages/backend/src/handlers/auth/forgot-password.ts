import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  ForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ForgotPasswordRequest } from '@anycompanyread/shared';
import { success, badRequest } from '../../utils/response';

const cognito = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

/**
 * Initiate password reset flow.
 * Sends a verification code to the user's email.
 */
export async function forgotPassword(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}') as ForgotPasswordRequest;

  if (!body.email) {
    return badRequest('Email is required');
  }

  await cognito.send(
    new ForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: body.email,
    })
  );

  return success({ message: 'Password reset code sent to your email' });
}
