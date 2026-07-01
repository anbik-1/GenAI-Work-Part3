import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  AdminConfirmSignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SignupRequest } from '@anycompanyread/shared';
import { created, badRequest } from '../../utils/response';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

/**
 * Handle user signup via Cognito.
 * Auto-confirms the user for demo simplicity (no email verification).
 */
export async function signup(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}') as SignupRequest;

  if (!body.email || !body.password || !body.name) {
    return badRequest('Email, password, and name are required');
  }

  // Register the user in Cognito
  await cognito.send(
    new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: body.email,
      Password: body.password,
      UserAttributes: [
        { Name: 'email', Value: body.email },
        { Name: 'name', Value: body.name },
      ],
    })
  );

  // Auto-confirm the user for demo purposes (skip email verification)
  await cognito.send(
    new AdminConfirmSignUpCommand({
      UserPoolId: USER_POOL_ID,
      Username: body.email,
    })
  );

  return created({ message: 'User registered successfully' });
}
