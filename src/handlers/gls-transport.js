const axios = require('axios');

const countryCodeLookup = require('country-code-lookup');

var { DateTime } = require('luxon');

var AWS = require('aws-sdk');
AWS.config.update({region:'eu-west-1'});

function createGLSAddress(address, contactPerson) {
	var glsAddress = new Object(); 
	if (contactPerson != null) {
		glsAddress.contact = contactPerson.name;
		glsAddress.email = contactPerson.email;
		glsAddress.mobile = contactPerson.mobileNumber;
		glsAddress.phone = contactPerson.phoneNumber;
	} 
	glsAddress.name1 = address.addressee;
	glsAddress.street1 = address.streetNameAndNumber;
	glsAddress.zipCode = address.postalCode;
	glsAddress.city = address.cityTownOrVillage;
	glsAddress.countryNum = countryCodeLookup.byIso(address.countryCode).isoNo;
	return glsAddress;
}

/**
 * Send a response to CloudFormation regarding progress in creating resource.
 */
async function sendResponse(input, context, responseStatus, reason) {

	let responseUrl = input.ResponseURL;

	let output = new Object();
	output.Status = responseStatus;
	output.PhysicalResourceId = "StaticFiles";
	output.StackId = input.StackId;
	output.RequestId = input.RequestId;
	output.LogicalResourceId = input.LogicalResourceId;
	output.Reason = reason;
	await axios.put(responseUrl, output);
}

exports.initializer = async (input, context) => {
	
	let ims = getIMS();
	
	try {
		let requestType = input.RequestType;
		if (requestType == "Create") {
			let carrier = new Object();
			carrier.carrierName = "GLS";
		    let setup = new Object();
			setup.userName = '2080060960';
			setup.password = 'API1234';
			setup.contactId = '208a144Uoo';
			setup.customerNumber = '2080060960';
			let dataDocument = new Object();
			dataDocument.GLSTransport = setup;
			carrier.dataDocument = JSON.stringify(dataDocument);
			await ims.post("carriers", carrier);
		}
		await sendResponse(input, context, "SUCCESS", null);

	} catch (error) {
		await sendResponse(input, context, "SUCCESS", error);
	}

}

async function getIMS() {
	
    const authUrl = "https://auth.thetis-ims.com/oauth2/";
    const apiUrl = "https://api.thetis-ims.com/2/";

	var clientId = process.env.ClientId;   
	var clientSecret = process.env.ClientSecret; 
	var apiKey = process.env.ApiKey;  
	
    let data = clientId + ":" + clientSecret;
	let base64data = Buffer.from(data, 'UTF-8').toString('base64');	
	
	var imsAuth = axios.create({
			baseURL: authUrl,
			headers: { Authorization: "Basic " + base64data, 'Content-Type': "application/x-www-form-urlencoded" },
			responseType: 'json'
		});
    
    var response = await imsAuth.post("token", 'grant_type=client_credentials');
    var token = response.data.token_type + " " + response.data.access_token;
    
    var ims = axios.create({
    		baseURL: apiUrl,
    		headers: { "Authorization": token, "x-api-key": apiKey }
    	});
	
	ims.interceptors.response.use(function (response) {
			console.log("SUCCESS " + JSON.stringify(response.data));
 	    	return response;
		}, function (error) {
			if (error.response) {
				console.log("FAILURE " + error.response.status + " - " + JSON.stringify(error.response.data));
			}
	    	return Promise.reject(error);
		});
	
	return ims;
}

async function getGLS(ims, eventId) {
 
    const glsUrl = "https://api.gls.dk/ws/DK/V1/";
    
    var gls = axios.create({
		baseURL: glsUrl
	});
	
	gls.interceptors.response.use(function (response) {
			console.log("SUCCESS " + JSON.stringify(response.data));
 	    	return response;
		}, function (error) {
			if (error.response) {
				console.log("FAILURE " + error.response.status + " - " + JSON.stringify(error.response.data));
				var message = new Object
				message.time = Date.now();
				message.source = "GLSTransport";
				message.messageType = "ERROR";
				message.messageText = error.response.data.Message;
				ims.post("events/" + eventId + "/messages", message);
			}
	    	return Promise.reject(error);
		});

	return gls;
}

function lookupCarrier(carriers, carrierName) {
	let i = 0;
    let found = false;
    while (!found && i < carriers.length) {
    	let carrier = carriers[i];
    	if (carrier.carrierName == carrierName) {
    		found = true;
    	} else {
    		i++;
    	}	
    }
    
    if (!found) {
    	throw new Error('No carrier by the name ' + carrierName);
    }

	return carriers[i];
}

/**
 * A Lambda function that get shipping labels for parcels from GLS.
 */
exports.shippingLabelRequestHandler = async (event, context) => {
	
    console.info(JSON.stringify(event));

    var detail = event.detail;
    var shipmentId = detail.shipmentId;
    var contextId = detail.contextId;

	let ims = await getIMS();
	
	let gls = await getGLS(ims, detail.eventId);

    let response = await ims.get("carriers");
    var carriers = response.data;
    
    let carrier = lookupCarrier(carriers, 'GLS');
    var dataDocument = JSON.parse(carrier.dataDocument);
    var setup = dataDocument.GLSTransport;
    
    response = await ims.get("shipments/" + shipmentId);
    var shipment = response.data;
    
	var glsShipment = new Object();
	
	glsShipment.userName = setup.userName;
	glsShipment.password = setup.password;
	glsShipment.customerId = setup.customerId;
	glsShipment.contactid = setup.contactId;
	glsShipment.shipmentDate = DateTime.local().toFormat('yyyyMMdd');
	glsShipment.reference = shipment.shipmentNumber;
	
	let i = 1;
	var parcels = [];
	var shippingContainers = [];
	shippingContainers = shipment.shippingContainers;
	shippingContainers.forEach(function(shippingContainer) {
    		var glsParcel = new Object();
    		glsParcel.reference = shipment.shipmentNumber + " #" + i;
    		glsParcel.weight = shippingContainer.grossWeight;
    		parcels.push(glsParcel);
    		i++;
    	});
	
	glsShipment.parcels = parcels;
	
	var glsAddresses = new Object();
	
	var contactPerson = shipment.contactPerson;
	
	var glsDeliveryAddress = createGLSAddress(shipment.deliveryAddress, contactPerson);
	
	var senderAddress;
	var senderContactPerson;
    var sellerId = shipment.sellerId;
	if (sellerId != null) {
	    response = await ims.get("sellers/" + sellerId);
		senderAddress = response.data.address;
		senderContactPerson = response.data.contactPerson;
	} else {
		senderAddress = context.address;
		senderContactPerson = context.contactPerson;
	}
	var glsAlternativeShipper = createGLSAddress(senderAddress, senderContactPerson);
	
	glsAddresses.delivery = glsDeliveryAddress;
	glsAddresses.alternativeShipper = glsAlternativeShipper;
	
	glsShipment.addresses = glsAddresses;
	
	var glsServices = new Object();
	if (shipment.pickUpPointId != null) {
		glsServices.shopDelivery = shipment.getPickUpPointId;
	}	
	if (contactPerson != null) {
		glsServices.setNotificationEmail = contactPerson.getEmail;
	}
	var notesOnDelivery = shipment.notesOnDelivery;
	if (notesOnDelivery != null) {
		if (notesOnDelivery.startsWith("Deposit")) {
			glsServices.deposit = notesOnDelivery.substring(7);
		}
		if (notesOnDelivery.startsWith("Flex")) {
			glsServices.flexDelivery = "Y";
		}
		if (notesOnDelivery.startsWith("DirectShop")) {
			glsServices.directShop = "Y";
		}
		if (notesOnDelivery.startsWith("Private")) {
			glsServices.privateDelivery = "Y";
		}
	}
	glsShipment.services = glsServices;

    response = await gls.post("CreateShipment", glsShipment);
    var glsResponse = response.data;
    
	var shippingLabel = new Object();
	shippingLabel.base64EncodedContent = glsResponse.PDF;
	shippingLabel.fileName = "SHIPPING_LABEL_" + shipmentId + ".pdf";
	await ims.post("shipments/"+ shipmentId + "/attachments", shippingLabel);

	await ims.put("shipments/" + shipmentId + "/consignmentId", glsResponse.consignmentId);

	for (let i = 0; i < glsResponse.parcels.length; i++) {
		let shippingContainer = shippingContainers[i];
		let parcel = parcels[i];
		ims.put("shippingContainers/" + shippingContainer.id + "/trackingNumber", parcel.parcelNumber);
	}
	
	var message = new Object();
	message.time = Date.now();
	message.source = "GLSTransport";
	message.messageType = "INFO";
	message.messageText = "Labels are ready";
	await ims.post("events/" + detail.eventId + "/messages", message);

	return "done";

}
