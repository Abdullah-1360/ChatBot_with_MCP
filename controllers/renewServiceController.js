/**
 * Renew Service Controller for MCP Server
 * Reuses existing service renewal logic from main application
 */

// Import services from main application
const { 
  genInvoices,
  getInvoice,
  getInvoices,
  getInvoicesForUser,
  openTicket,
  addOrder,
  getClientsProducts,
  getClientsDomains,
  getClientsDetails,
  callApi
} = require('../../src/services/whmcsService');

const { 
  getServiceForClient,
  getDomainForClient,
  findRelatedUnpaidInvoice,
  amountFromInvoice
} = require('../../src/utils/helpers');

const { normalizePhone, phonesMatch, maskPhone } = require('../../src/utils/phoneNormalizer');

/**
 * Helper function to resolve domain to client
 */
async function resolveDomainToClient(domain) {
  // Try GetClientsDomains first
  const domainsData = await callApi('GetClientsDomains', { domain });
  
  if (domainsData && domainsData.domains) {
    const domainsRaw = domainsData.domains;
    const domains = domainsRaw.domain || domainsRaw;
    const domainArray = Array.isArray(domains) ? domains : (domains ? [domains] : []);
    
    if (domainArray.length > 0) {
      const uniqueUserIds = [...new Set(domainArray.map(d => String(d.userid)))];
      
      if (uniqueUserIds.length > 1) {
        throw new Error('Multiple clients found for this domain');
      }
      
      return { clientId: uniqueUserIds[0], source: 'domains' };
    }
  }
  
  // Fallback: Try GetClientsProducts
  const productsData = await callApi('GetClientsProducts', { domain });
  
  if (productsData && productsData.products) {
    const productsRaw = productsData.products;
    const products = productsRaw.product || productsRaw;
    const productArray = Array.isArray(products) ? products : (products ? [products] : []);
    
    if (productArray.length > 0) {
      const uniqueUserIds = [...new Set(productArray.map(p => String(p.userid || p.clientid)))];
      
      if (uniqueUserIds.length > 1) {
        throw new Error('Multiple clients found for this domain');
      }
      
      return { clientId: uniqueUserIds[0], source: 'products' };
    }
  }
  
  throw new Error('No client found with that domain');
}

/**
 * Helper function to resolve email to client
 */
async function resolveEmailToClient(email) {
  const clientData = await getClientsDetails({ email });
  
  if (clientData && clientData.userid) {
    return { clientId: String(clientData.userid), source: 'email' };
  }
  
  throw new Error('No client found with that email address');
}

/**
 * Helper function to validate client phone number
 */
async function validateClientPhone(clientId, providedPhone) {
  try {
    const clientData = await getClientsDetails({ clientid: clientId });
    
    if (!clientData) {
      throw new Error('Client not found');
    }
    
    const registeredPhone = clientData.phonenumber || clientData.phone;
    
    if (!registeredPhone) {
      return { valid: true, reason: 'no_phone_on_file' };
    }
    
    // Use the phone normalizer utility for consistent validation
    const isMatch = phonesMatch(registeredPhone, providedPhone);
    
    console.log(`→ Phone validation: Registered=${normalizePhone(registeredPhone).substring(0, 3)}***, Provided=${normalizePhone(providedPhone).substring(0, 3)}***, Match=${isMatch}`);
    
    return {
      valid: isMatch,
      registeredPhone: registeredPhone,
      reason: isMatch ? 'phone_match' : 'phone_mismatch'
    };
    
  } catch (error) {
    throw new Error(`Phone validation failed: ${error.message}`);
  }
}

/**
 * Helper function to mask phone number
 */
function maskPhoneNumber(phone) {
  // Use the phone normalizer utility for consistent masking
  return maskPhone(phone);
}

/**
 * Renew a service or domain with automatic client resolution
 * @param {Object} params - Parameters from MCP call
 * @param {string} params.domain - Domain name (required)
 * @param {string} params.email - Client email (optional, auto-resolved if not provided)
 * @param {string} params.phone - Client phone (optional, auto-filled by uChat)
 * @param {string} params.clientId - WHMCS client ID (optional, auto-resolved if not provided)
 * @returns {Promise<Object>} Service renewal result
 */
async function renewService(params) {
  const { 
    domain, 
    email, 
    phone = "{{User_id}}", 
    clientId, 
    number, 
    user_ns 
  } = params;
  
  // Log parameters received from MCP
  console.log('[MCP renewService] Parameters received:', {
    domain: domain || 'N/A',
    hasEmail: !!email,
    phone: phone ? (phone.startsWith('{{') ? phone : `${phone.substring(0, 3)}***`) : 'N/A',
    hasClientId: !!clientId,
    hasUserNs: !!user_ns
  });
  
  try {
    // Validate required parameters
    if (!domain) {
      throw new Error('domain is required');
    }
    
    if (!email && !phone && !clientId) {
      throw new Error('email, phone, or clientId is required for client identification');
    }
    
    let resolvedClientId = clientId;
    let resolvedFrom = 'provided';
    
    // PARALLEL CLIENT RESOLUTION: Try email AND domain in parallel if no clientId provided
    if (!resolvedClientId && (email || domain)) {
      console.log('→ Starting parallel client resolution...');
      
      const parallelTasks = [];
      
      // Task 1: Email resolution (if provided)
      if (email) {
        parallelTasks.push(
          resolveEmailToClient(email)
            .then(result => ({ type: 'email', success: true, data: result }))
            .catch(error => ({ type: 'email', success: false, error: error.message }))
        );
      }
      
      // Task 2: Domain resolution (always try)
      parallelTasks.push(
        resolveDomainToClient(domain)
          .then(result => ({ type: 'domain', success: true, data: result }))
          .catch(error => ({ type: 'domain', success: false, error: error.message }))
      );
      
      // Execute parallel resolution
      const results = await Promise.allSettled(parallelTasks);
      
      // Process results - prioritize successful resolutions
      let emailResult = null;
      let domainResult = null;
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          if (result.value.type === 'email') {
            emailResult = result.value.data;
          } else if (result.value.type === 'domain') {
            domainResult = result.value.data;
          }
        }
      }
      
      // Determine which resolution to use - handle edge cases
      if (domainResult && emailResult) {
        // Both resolved - check if they match
        if (domainResult.clientId === emailResult.clientId) {
          resolvedClientId = domainResult.clientId;
          resolvedFrom = 'domain+email';
          console.log('→ Client resolved from both domain and email (matching):', resolvedClientId);
        } else {
          // Edge case: Different clients found - prioritize domain over email
          console.log('→ Domain and email resolve to different clients - prioritizing domain');
          resolvedClientId = domainResult.clientId;
          resolvedFrom = 'domain_priority';
          console.log('→ Client resolved from domain (email mismatch ignored):', resolvedClientId);
        }
      } else if (domainResult) {
        // Only domain resolved - email was wrong or not provided
        resolvedClientId = domainResult.clientId;
        resolvedFrom = 'domain';
        console.log('→ Client resolved from domain:', resolvedClientId);
      } else if (emailResult) {
        // Only email resolved - domain was wrong or not provided
        resolvedClientId = emailResult.clientId;
        resolvedFrom = 'email';
        console.log('→ Client resolved from email:', resolvedClientId);
      } else {
        // Neither resolved successfully
        const errorMessages = [];
        if (email) errorMessages.push('No client found for the provided email');
        if (domain) errorMessages.push('No client found for the provided domain');
        
        throw new Error(errorMessages.join(' and ') + '. Please verify your information.');
      }
    }
    
    // Validate that we have a resolved client
    if (!resolvedClientId) {
      throw new Error('Could not resolve client from provided information. Please provide email or domain.');
    }
    
    // PHONE VALIDATION: Validate phone number if provided (after client resolution)
    if (phone && phone !== "{{User_id}}" && resolvedClientId) {
      console.log('→ Performing phone validation...');
      
      try {
        const phoneValidationResult = await validateClientPhone(resolvedClientId, phone);
        
        if (!phoneValidationResult.valid) {
          // Phone validation failed - return masked phone error
          const maskedPhone = phoneValidationResult.registeredPhone 
            ? maskPhoneNumber(phoneValidationResult.registeredPhone)
            : 'your registered number';
            
          throw new Error(`Please contact from ${maskedPhone} or change the phone number from your client area to ${phone} (current number)`);
        }
        
        console.log('✓ Phone validation passed');
      } catch (error) {
        console.log('✗ Phone validation error:', error.message);
        throw new Error('Phone validation failed. Please try again or contact support.');
      }
    }
    
    // Use the resolved clientId for the rest of the function
    const finalClientId = resolvedClientId;
    
    // Step 1: Service Validation (Pre-check)
    console.log('→ Step 1: Service Validation');
    
    let serviceId = null;
    let domainId = null;
    let serviceData = null;
    let domainData = null;
    let isHostingService = false;
    let isDomainService = false;
    
    // Check for hosting service first
    try {
      const productsResponse = await getClientsProducts(finalClientId);
      const products = productsResponse.products?.product || [];
      const productArray = Array.isArray(products) ? products : (products ? [products] : []);
      
      serviceData = productArray.find(product => 
        product.domain === domain || 
        (product.customfields && product.customfields.customfield && 
         Array.isArray(product.customfields.customfield) &&
         product.customfields.customfield.some(field => 
           field.value === domain
         ))
      );
      
      if (serviceData) {
        serviceId = serviceData.id;
        isHostingService = true;
        console.log('→ Hosting service found:', serviceId, 'Status:', serviceData.status);
      }
    } catch (error) {
      console.log('→ Error checking hosting services:', error.message);
    }
    
    // Check for domain service if no hosting service found
    if (!serviceData) {
      try {
        const domainsResponse = await getClientsDomains(finalClientId);
        const domains = domainsResponse.domains?.domain || [];
        const domainArray = Array.isArray(domains) ? domains : (domains ? [domains] : []);
        
        domainData = domainArray.find(d => d.domain === domain);
        
        if (domainData) {
          domainId = domainData.id;
          isDomainService = true;
          console.log('→ Domain service found:', domainId, 'Status:', domainData.status);
        }
      } catch (error) {
        console.log('→ Error checking domains:', error.message);
      }
    }
    
    if (!serviceData && !domainData) {
      throw new Error(`No service or domain found for ${domain}. Please check if this service belongs to your account.`);
    }
    
    // Check for existing unpaid invoice
    console.log('→ Step 2: Checking for existing unpaid invoices...');
    
    const existing = await findRelatedUnpaidInvoice(finalClientId, { 
      domain: domain,
      serviceId: serviceId,
      domainId: domainId
    });
    
    if (existing) {
      const amount = amountFromInvoice(existing);
      const invoiceId = existing.invoiceid || existing.id;
      const dueDate = existing.duedate;
      
      console.log('→ Existing invoice found:', invoiceId, 'Due:', dueDate, 'Amount:', amount);
      
      // Check if invoice is overdue
      const now = new Date();
      const due = new Date(dueDate);
      const isOverdue = due < now;
      
      let message;
      if (isOverdue) {
        const daysOverdue = Math.ceil((now - due) / (1000 * 60 * 60 * 24));
        message = `Invoice #${invoiceId} for renewal is overdue by ${daysOverdue} day(s) (due: ${dueDate}). Please pay ${amount} to reactivate your service.`;
      } else {
        message = `An invoice for renewal already exists: Invoice #${invoiceId} for ${amount} due on ${dueDate}. Please pay this invoice to renew your service.`;
      }
      
      return {
        success: true,
        existingInvoice: true,
        invoiceId: invoiceId,
        amount: amount,
        dueDate: dueDate,
        isOverdue: isOverdue,
        message: message,
        clientId: finalClientId,
        resolvedFrom: resolvedFrom
      };
    }
    
    // Step 3: Service Status Validation
    console.log('→ Step 3: Service Status Validation');
    
    if (isHostingService && serviceData) {
      console.log('→ Service details:', { 
        id: serviceData.id, 
        status: serviceData.status, 
        domain: serviceData.domain, 
        nextduedate: serviceData.nextduedate,
        billingcycle: serviceData.billingcycle 
      });
      
      // Check if service can be renewed
      const nonRenewableStatuses = ['Cancelled', 'Terminated', 'Fraud'];
      if (nonRenewableStatuses.includes(serviceData.status)) {
        throw new Error(`Service cannot be renewed because it is ${serviceData.status}. Please contact support.`);
      }
      
      // Check if service is Active
      if (serviceData.status !== 'Active') {
        throw new Error(`Service status is ${serviceData.status}. Only Active services can be renewed.`);
      }
    }
    
    if (isDomainService && domainData) {
      console.log('→ Domain details:', { 
        id: domainData.id, 
        status: domainData.status, 
        domain: domainData.domain, 
        nextduedate: domainData.nextduedate
      });
      
      // Check if domain can be renewed
      const nonRenewableStatuses = ['Cancelled', 'Terminated', 'Fraud', 'Expired'];
      if (nonRenewableStatuses.includes(domainData.status)) {
        throw new Error(`Domain cannot be renewed because it is ${domainData.status}. Please contact support.`);
      }
    }
    
    // Step 4: Generate Renewal Invoice
    console.log('→ Step 4: Generating renewal invoice...');
    
    if (isHostingService && serviceId) {
      // Use GenInvoices for hosting services
      console.log('→ Calling GenInvoices for hosting service:', serviceId);
      
      await genInvoices({ 
        serviceids: String(serviceId)
      });
      
      console.log('→ GenInvoices called, checking for invoice...');
      
      // Wait briefly for WHMCS to generate the invoice
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Fetch recent unpaid invoices
      const invoices = await getInvoices({ 
        userid: finalClientId, 
        status: 'Unpaid',
        limitnum: 10,
        orderby: 'date',
        order: 'DESC'
      });
      
      const invoiceList = invoices.invoices?.invoice || [];
      const invoiceArray = Array.isArray(invoiceList) ? invoiceList : (invoiceList ? [invoiceList] : []);
      
      // Find the most recent invoice that might be for this service
      const recentInvoice = invoiceArray.find(inv => {
        const invoiceDate = new Date(inv.date);
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        return invoiceDate >= fiveMinutesAgo;
      });
      
      if (recentInvoice) {
        const amount = amountFromInvoice(recentInvoice);
        const invoiceId = recentInvoice.invoiceid || recentInvoice.id;
        
        console.log('✅ Renewal invoice generated:', invoiceId, 'Amount:', amount);
        
        return {
          success: true,
          invoiceGenerated: true,
          invoiceId: invoiceId,
          amount: amount,
          dueDate: recentInvoice.duedate,
          message: `Renewal invoice #${invoiceId} generated successfully for ${amount}. Please pay to complete the renewal.`,
          serviceType: 'hosting',
          serviceId: serviceId,
          domain: domain,
          clientId: finalClientId,
          resolvedFrom: resolvedFrom
        };
      } else {
        // No recent invoice found - might be a limitation
        console.log('⚠️ No recent invoice found after GenInvoices call');
        
        return {
          success: true,
          invoiceGenerated: false,
          message: `Service renewal initiated for ${domain}. WHMCS will automatically generate an invoice 7-14 days before the due date. For immediate renewal, please contact support.`,
          serviceType: 'hosting',
          serviceId: serviceId,
          domain: domain,
          clientId: finalClientId,
          resolvedFrom: resolvedFrom,
          note: 'WHMCS API limitation: Service renewals may require manual invoice generation by admin'
        };
      }
      
    } else if (isDomainService && domainId) {
      // Use AddOrder for domain renewals
      console.log('→ Using AddOrder for domain renewal:', domain);
      
      const orderParams = {
        clientid: finalClientId,
        domainrenewals: [`${domain}:1`], // Renew for 1 year
        paymentmethod: process.env.DEFAULT_PAYMENT_METHOD || 'hostbreakbanktransfer'
      };
      
      const orderResult = await addOrder(orderParams);
      
      if (orderResult.result === 'success') {
        const orderId = orderResult.orderid;
        const invoiceId = orderResult.invoiceid;
        
        console.log('✅ Domain renewal order created:', orderId, 'Invoice:', invoiceId);
        
        // Get invoice details
        let invoiceDetails = null;
        if (invoiceId) {
          try {
            invoiceDetails = await getInvoice(invoiceId);
          } catch (error) {
            console.log('→ Could not fetch invoice details:', error.message);
          }
        }
        
        const amount = invoiceDetails ? amountFromInvoice(invoiceDetails) : 'N/A';
        
        return {
          success: true,
          invoiceGenerated: true,
          orderId: orderId,
          invoiceId: invoiceId,
          amount: amount,
          dueDate: invoiceDetails?.duedate,
          message: `Domain renewal order created successfully. Invoice #${invoiceId} for ${amount}. Please pay to complete the renewal.`,
          serviceType: 'domain',
          domainId: domainId,
          domain: domain,
          clientId: finalClientId,
          resolvedFrom: resolvedFrom
        };
      } else {
        throw new Error(`Domain renewal failed: ${orderResult.message || 'Unknown error'}`);
      }
    }
    
    // Fallback - should not reach here
    throw new Error('Unable to determine service type for renewal');
    
  } catch (error) {
    console.log('✗ Service renewal error:', error.message);
    throw error;
  }
}

module.exports = {
  renewService
};