#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AnyCompanyReadStack } from '../lib/anycompanyread-stack';

const app = new cdk.App();

new AnyCompanyReadStack(app, 'AnyCompanyReadStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'AnyCompanyRead - Online Book E-Commerce Platform',
});
