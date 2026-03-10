/**
 * Ticket Controller for MCP Server
 * Reuses existing ticket lookup logic from main application
 */

// Import the existing WHMCS service from the main application
const { getTicketWithClientValidation } = require('../../src/services/whmcsService');

/**
 * Lookup ticket with client validation via phone number
 * @param {Object} params - Parameters from MCP call
 * @param {string} params.phone - Client phone number (required)
 * @param {string} params.ticket - Ticket number (required)
 * @returns {Promise<Object>} Ticket lookup result
 */
async function lookupTicket(params) {
  const { phone = "{{User_id}}", ticket } = params;
  
  // Log the phone number that AI sends (as requested)
  console.log('[MCP ticketLookup] Phone number from uChat variable:', phone);
  console.log('[MCP ticketLookup] Ticket number:', ticket);
  
  try {
    // Validate required parameters
    if (!ticket) {
      throw new Error('ticket parameter is required');
    }
    
    // Phone should be automatically provided by uChat, but validate it's not empty
    if (!phone || phone.trim() === '' || phone === '{{User_id}}') {
      throw new Error('Phone number not available from uChat variables. Please ensure user phone is set in uChat.');
    }
    
    // Validate phone format (basic validation)
    const phoneStr = phone.toString().trim();
    
    // Remove all non-digit characters for validation
    const digitsOnly = phoneStr.replace(/\D/g, '');
    
    if (digitsOnly.length < 10) {
      throw new Error('phone number must be at least 10 digits');
    }
    
    console.log(`→ Phone format: ${digitsOnly.substring(0, 3)}*** (${digitsOnly.length} digits)`);
    
    // Validate ticket format (should be numeric)
    const ticketStr = ticket.toString().trim();
    if (!/^\d+$/.test(ticketStr)) {
      throw new Error('ticket number must be numeric');
    }
    
    console.log(`→ Looking up ticket ${ticketStr} for phone ${phoneStr.substring(0, 3)}***`);
    
    // Get ticket with client validation using existing service
    const result = await getTicketWithClientValidation(ticketStr, phoneStr);
    
    if (!result || !result.ticket) {
      throw new Error('Ticket not found or access denied');
    }
    
    const { ticket: ticketData, client: clientData } = result;
    
    // Format ticket summary (same logic as original controller)
    const ticketSummary = {
      ticketId: ticketData.id || ticketData.tid,
      ticketNumber: ticketData.tid || ticketData.id,
      subject: ticketData.subject,
      status: ticketData.status,
      priority: ticketData.priority,
      department: ticketData.deptname || ticketData.department,
      departmentId: ticketData.deptid || ticketData.departmentid,
      dateOpened: ticketData.date,
      lastReply: ticketData.lastreply,
      clientName: `${clientData.firstname} ${clientData.lastname}`.trim(),
      clientEmail: clientData.email,
      clientId: clientData.id || clientData.userid,
      
      // Ticket details
      message: ticketData.message || 'No message available',
      
      // Status information
      isOpen: ['Open', 'Customer-Reply', 'In Progress'].includes(ticketData.status),
      isClosed: ['Closed', 'Resolved'].includes(ticketData.status),
      
      // Additional metadata
      replies: ticketData.replies || [],
      totalReplies: ticketData.replies ? ticketData.replies.length : 0,
      
      // Service information (if available)
      serviceId: ticketData.serviceid || null,
      
      // Search and validation information
      phoneValidated: result.phoneValidated,
      searchMethod: result.searchMethod,
      departmentId: result.departmentId,
      departmentName: result.departmentName,
      
      // Formatted summary
      summary: generateTicketSummary(ticketData, clientData)
    };
    
    console.log(`✅ Ticket ${ticketSummary.ticketNumber} found for client ${ticketSummary.clientName}`);
    console.log(`→ Status: ${ticketSummary.status}, Department: ${ticketSummary.department}`);
    
    return {
      success: true,
      ticket: ticketSummary,
      message: `Ticket ${ticketSummary.ticketNumber} retrieved successfully`
    };
    
  } catch (error) {
    console.log('✗ Ticket lookup error:', error.message);
    
    // Handle specific error cases
    if (error.message.includes('Ticket not found')) {
      throw new Error('Ticket not found with the provided ticket number');
    }
    
    if (error.message.includes('Phone number does not match') || error.message.includes('Please contact from your registered number')) {
      throw new Error(error.message.replace('Ticket lookup failed: ', ''));
    }
    
    if (error.message.includes('Client not found')) {
      throw new Error('Client information not found for this ticket');
    }
    
    // Re-throw the error for MCP to handle
    throw error;
  }
}

/**
 * Generate a human-readable ticket summary
 * @param {Object} ticketData - Ticket data from WHMCS
 * @param {Object} clientData - Client data from WHMCS
 * @returns {string} Formatted summary
 */
function generateTicketSummary(ticketData, clientData) {
  const clientName = `${clientData.firstname} ${clientData.lastname}`.trim();
  const status = ticketData.status;
  const department = ticketData.deptname || ticketData.department || 'Support';
  const dateOpened = ticketData.date;
  const subject = ticketData.subject;
  
  let summary = `Ticket #${ticketData.tid || ticketData.id} for ${clientName}\n`;
  summary += `Subject: ${subject}\n`;
  summary += `Status: ${status}\n`;
  summary += `Department: ${department}\n`;
  summary += `Opened: ${dateOpened}\n`;
  
  if (ticketData.lastreply) {
    summary += `Last Reply: ${ticketData.lastreply}\n`;
  }
  
  if (ticketData.priority) {
    summary += `Priority: ${ticketData.priority}\n`;
  }
  
  // Add status-specific information
  if (['Open', 'Customer-Reply', 'In Progress'].includes(status)) {
    summary += `\nThis ticket is currently active and being handled by our support team.`;
  } else if (['Closed', 'Resolved'].includes(status)) {
    summary += `\nThis ticket has been resolved and closed.`;
  }
  
  // Add reply count if available
  if (ticketData.replies && ticketData.replies.length > 0) {
    summary += ` There are ${ticketData.replies.length} replies in this conversation.`;
  }
  
  return summary;
}

module.exports = {
  lookupTicket
};