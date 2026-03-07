/**
 * MongoDB Database Connection for MCP Server
 */

const mongoose = require('mongoose');

let isConnected = false;

async function connectDB() {
  if (isConnected) {
    return;
  }

  try {
    const mongoUri = process.env.MONGODB_URI;
    
    if (!mongoUri) {
      throw new Error('MONGODB_URI environment variable is not set');
    }
    
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });

    isConnected = true;
    console.log('✅ MCP Server: MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MCP Server: MongoDB connection error:', error.message);
    throw error;
  }
}

// Handle connection events
mongoose.connection.on('disconnected', () => {
  isConnected = false;
  console.log('⚠️  MCP Server: MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MCP Server: MongoDB error:', err.message);
});

module.exports = { connectDB };
