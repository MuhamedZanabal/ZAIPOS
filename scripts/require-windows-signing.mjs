const certificate = process.env.CSC_LINK;
const password = process.env.CSC_KEY_PASSWORD;

if (!certificate || !password) {
  console.error(
    'Unsigned production releases are forbidden. Set CSC_LINK and CSC_KEY_PASSWORD through the protected release environment.',
  );
  process.exit(1);
}

console.log('Windows production signing credentials are present.');
