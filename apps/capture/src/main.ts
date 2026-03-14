import { createApp } from './app/createApp';

const app = createApp();

app.start().catch((error) => {
  console.error(error);
});
