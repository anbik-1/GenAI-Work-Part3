import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';

export class AnyCompanyReadStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==========================================
    // COGNITO - User Authentication
    // ==========================================
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'AnyCompanyRead-UserPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'AnyCompanyRead-WebClient',
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });

    // ==========================================
    // DYNAMODB - Data Storage
    // ==========================================
    const booksTable = new dynamodb.Table(this, 'BooksTable', {
      tableName: 'AnyCompanyRead-Books',
      partitionKey: { name: 'bookId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cartsTable = new dynamodb.Table(this, 'CartsTable', {
      tableName: 'AnyCompanyRead-Carts',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'bookId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: 'AnyCompanyRead-Orders',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const orderItemsTable = new dynamodb.Table(this, 'OrderItemsTable', {
      tableName: 'AnyCompanyRead-OrderItems',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'bookId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ==========================================
    // S3 - Static Hosting & Images
    // ==========================================
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `anycompanyread-frontend-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const imagesBucket = new s3.Bucket(this, 'ImagesBucket', {
      bucketName: `anycompanyread-images-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ==========================================
    // CLOUDFRONT - CDN
    // ==========================================
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/images/*': {
          origin: new origins.S3Origin(imagesBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html', // SPA fallback
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // ==========================================
    // LAMBDA - Backend Functions
    // ==========================================
    const commonEnv = {
      BOOKS_TABLE_NAME: booksTable.tableName,
      CARTS_TABLE_NAME: cartsTable.tableName,
      ORDERS_TABLE_NAME: ordersTable.tableName,
      ORDER_ITEMS_TABLE_NAME: orderItemsTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
    };

    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: commonEnv,
      bundling: {
        externalModules: ['@aws-sdk/*'], // Provided by Lambda runtime
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
    };

    const backendSrc = path.join(__dirname, '../../backend/src');

    const authFunction = new NodejsFunction(this, 'AuthFunction', {
      ...lambdaDefaults,
      functionName: 'AnyCompanyRead-Auth',
      entry: path.join(backendSrc, 'handlers/auth/index.ts'),
      handler: 'handler',
    });

    const booksFunction = new NodejsFunction(this, 'BooksFunction', {
      ...lambdaDefaults,
      functionName: 'AnyCompanyRead-Books',
      entry: path.join(backendSrc, 'handlers/books/index.ts'),
      handler: 'handler',
    });

    const cartFunction = new NodejsFunction(this, 'CartFunction', {
      ...lambdaDefaults,
      functionName: 'AnyCompanyRead-Cart',
      entry: path.join(backendSrc, 'handlers/cart/index.ts'),
      handler: 'handler',
    });

    const ordersFunction = new NodejsFunction(this, 'OrdersFunction', {
      ...lambdaDefaults,
      functionName: 'AnyCompanyRead-Orders',
      entry: path.join(backendSrc, 'handlers/orders/index.ts'),
      handler: 'handler',
    });

    // Grant permissions
    booksTable.grantReadData(booksFunction);
    booksTable.grantReadData(cartFunction); // For denormalization lookup
    cartsTable.grantReadWriteData(cartFunction);
    cartsTable.grantReadWriteData(ordersFunction); // For checkout (read + clear)
    ordersTable.grantReadWriteData(ordersFunction);
    orderItemsTable.grantReadWriteData(ordersFunction);

    // Cognito permissions for auth Lambda
    authFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:SignUp',
          'cognito-idp:ForgotPassword',
          'cognito-idp:ConfirmForgotPassword',
        ],
        resources: [userPool.userPoolArn],
      })
    );

    // ==========================================
    // API GATEWAY - REST API
    // ==========================================
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'AnyCompanyRead-API',
      description: 'AnyCompanyRead REST API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ApiAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'CognitoAuthorizer',
    });

    const authMethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Auth routes (public)
    const authResource = api.root.addResource('auth');
    authResource.addResource('signup').addMethod('POST', new apigateway.LambdaIntegration(authFunction));
    authResource.addResource('login').addMethod('POST', new apigateway.LambdaIntegration(authFunction));
    authResource.addResource('forgot-password').addMethod('POST', new apigateway.LambdaIntegration(authFunction));
    authResource.addResource('confirm-forgot-password').addMethod('POST', new apigateway.LambdaIntegration(authFunction));

    // Books routes (public)
    const booksResource = api.root.addResource('books');
    booksResource.addMethod('GET', new apigateway.LambdaIntegration(booksFunction));
    const bookByIdResource = booksResource.addResource('{bookId}');
    bookByIdResource.addMethod('GET', new apigateway.LambdaIntegration(booksFunction));

    // Cart routes (authenticated)
    const cartResource = api.root.addResource('cart');
    cartResource.addMethod('GET', new apigateway.LambdaIntegration(cartFunction), authMethodOptions);
    cartResource.addMethod('POST', new apigateway.LambdaIntegration(cartFunction), authMethodOptions);
    const cartByBookResource = cartResource.addResource('{bookId}');
    cartByBookResource.addMethod('PUT', new apigateway.LambdaIntegration(cartFunction), authMethodOptions);
    cartByBookResource.addMethod('DELETE', new apigateway.LambdaIntegration(cartFunction), authMethodOptions);

    // Checkout route (authenticated)
    api.root.addResource('checkout').addMethod('POST', new apigateway.LambdaIntegration(ordersFunction), authMethodOptions);

    // Orders routes (authenticated)
    const ordersResource = api.root.addResource('orders');
    ordersResource.addMethod('GET', new apigateway.LambdaIntegration(ordersFunction), authMethodOptions);
    const orderByIdResource = ordersResource.addResource('{orderId}');
    orderByIdResource.addMethod('GET', new apigateway.LambdaIntegration(ordersFunction), authMethodOptions);

    // ==========================================
    // OUTPUTS
    // ==========================================
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      description: 'Frontend S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'ImagesBucketName', {
      value: imagesBucket.bucketName,
      description: 'Images S3 Bucket Name',
    });
  }
}
