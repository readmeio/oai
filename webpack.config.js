const TerserPlugin = require('terser-webpack-plugin');
const path = require('path');

module.exports = {
  entry: ['./src/index.js'],
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: ['./src/cli/'],
        use: {
          loader: 'babel-loader',
          options: {
            extends: './.babelrc',
          },
        },
      },
    ],
  },
  optimization: {
    minimize: true,
    minimizer: [new TerserPlugin()],
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    libraryTarget: 'commonjs2',
  },
  target: 'web',
};
