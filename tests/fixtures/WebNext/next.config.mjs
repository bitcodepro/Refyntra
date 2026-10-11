const config = {
  async rewrites() {
    return [{ source: '/old-orders/:id', destination: '/orders/:id' }];
  },
};
export default config;
