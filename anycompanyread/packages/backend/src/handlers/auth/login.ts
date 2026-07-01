import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AuthFlowType,
} from '@aws-sdk/client-cognito-identity-provider';
import { LoginRequest } from '@anycompanyread/shared';
import { success, badRequest } from '../../utils/response';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

/**
 * Handle user login via Cognito AdminInitiateAuth.
 * Returns JWT tokens (idToken, accessToken, refreshToken).
 */
export async function login(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}') as LoginRequest;

  if (!body.email || !body.password) {
    return badRequest('Email and password are required');
  }

  const result = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      AuthFlow: AuthFlowType.ADMIN_USER_PASSWORD_AUTH,
      AuthParameters: {
        USERNAME: body.email,
        PASSWORD: body.password,
      },
    })
  );

  const authResult = result.AuthenticationResult;
  if (!authResult) {
    return badRequest('Authentication failed');
  }

  return success({
    idToken: authResult.IdToken,
    accessToken: authResult.AccessToken,
    refreshToken: authResult.RefreshToken,
  });
}
