/**
 * Standalone server for Plans MCP Server (MongoDB Production)
 * Run with: node api/server.js
 */

const app = require('./index.js');
const { connectDB } = require('./config/database');
const HostingPlan = require('./models/HostingPlan');

const PORT = process.env.MCP_PORT || 3002;

// Initialize MongoDB before starting server
async function startServer() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await connectDB();
    
    const count = await HostingPlan.countDocuments();
    console.log(`✅ MongoDB connected - ${count} plans loaded`);
    
    app.listen(PORT, () => {
      console.log('🚀 Plans MCP Server (MongoDB) running');
      console.log(`📡 Port: ${PORT}`);
      console.log(`🗄️  Database: MongoDB (${count} plans)`);
      console.log(`🌐 SSE endpoint: http://localhost:${PORT}/sse`);
      console.log(`💬 Health check: http://localhost:${PORT}/health`);
      console.log(`📊 Logs: http://localhost:${PORT}/logs`);
      console.log('\nPress Ctrl+C to stop');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
