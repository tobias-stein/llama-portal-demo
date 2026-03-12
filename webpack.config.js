const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  // Define an entry point for each page
  entry: {
    index: './src/lib/index-app.js',
    booking: './src/lib/booking-app.js',
    status: './src/lib/status-app.js',
    admin: './src/lib/admin-app.js',
  },
  output: {
    filename: '[name].bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true, // Clean the dist folder before each build
  },
  plugins: [
    // Copy static assets like CSS and images to the dist folder
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/css', to: 'css' },
        { from: 'src/img', to: 'img' },
      ],
    }),

    // Generate index.html from template
    new HtmlWebpackPlugin({
      template: './src/index.html',
      filename: 'index.html',
      chunks: ['index'], // Only include the index.bundle.js
    }),

    // Generate booking.html from template
    new HtmlWebpackPlugin({
      template: './src/booking.html',
      filename: 'booking.html',
      chunks: ['booking'], // Only include the booking.bundle.js
    }),

    // Generate admin.html from template
    new HtmlWebpackPlugin({
      template: './src/admin.html',
      filename: 'admin.html',
      chunks: ['admin'], // Only include the admin.bundle.js
    }),
    // Generate status.html from template
    new HtmlWebpackPlugin({
      template: './src/status.html',
      filename: 'status.html',
      chunks: ['status'], // Only include the status.bundle.js
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    compress: true,
    port: 9000,
    open: true, // Automatically open the browser
  },
  // Optimization settings to handle potential AWS SDK issues
  optimization: {
    splitChunks: {
      chunks: 'all',
    },
  },
};