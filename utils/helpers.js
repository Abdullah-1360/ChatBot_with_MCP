/**
 * Helper utilities for MCP Server
 */

const { getInvoice, getInvoices, getClientsProducts, getClientsDomains } = require('../services/whmcsService');

/**
 * Convert WHMCS status to message-friendly status
 */
function toMessageStatus(status) {
  if (!status) return 'Unknown';
  return status;
}

/**
 * Calculate amount due from invoice
 */
function amountFromInvoice(inv) {
  const total = inv.total || inv.amount || inv.subtotal;
  if (inv.balance !== undefined) return Number(inv.balance);
  if (total !== undefined && inv.amountpaid !== undefined) {
    const due = Number(total) - Number(inv.amountpaid);
    return Number.isFinite(due) ? due : Number(total);
  }
  return Number(total) || 0;
}

/**
 * Find related unpaid invoice for a service or domain
 * Properly parses invoice items and matches by relid (related ID)
 */
async function findRelatedUnpaidInvoice(clientId, { domain, serviceId, domainId }) {
  const list = await getInvoices({ userid: clientId, status: 'Unpaid', limitnum: 50 });
  const arr = (list.invoices && (list.invoices.invoice || list.invoices.invoices)) || [];
  
  for (const inv of arr) {
    const id = inv.id || inv.invoiceid || inv.invoicenum;
    if (!id) continue;
    
    try {
      const detail = await getInvoice(id);
      
      // Parse invoice items
      const items = detail.items?.item || [];
      const itemArray = Array.isArray(items) ? items : (items ? [items] : []);
      
      // Check each item for a match
      for (const item of itemArray) {
        const itemRelId = String(item.relid || '');
        const itemType = String(item.type || '').toLowerCase();
        const itemDescription = String(item.description || '').toLowerCase();
        
        // Match by service ID (for hosting/services)
        if (serviceId && itemRelId === String(serviceId)) {
          return detail;
        }
        
        // Match by domain ID (for domain registrations)
        if (domainId && itemRelId === String(domainId)) {
          return detail;
        }
        
        // Fallback: Match by domain name in description
        if (domain && itemDescription.includes(String(domain).toLowerCase())) {
          return detail;
        }
      }
    } catch (err) {
      // Error checking invoice - continue to next
    }
  }
  
  return null;
}

module.exports = {
  toMessageStatus,
  amountFromInvoice,
  findRelatedUnpaidInvoice
};
