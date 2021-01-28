/**
 * Copyright 2021 Thetis Apps Aps
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * 
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * 
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
	
	try {
		let ims = await getIMS();
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
		await sendResponse(input, context, "SUCCESS", "OK");

	} catch (error) {
		await sendResponse(input, context, "SUCCESS", JSON.stringify(error));
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
    		headers: { "Authorization": token, "x-api-key": apiKey, "Content-Type": "application/json" }
    	});
	

	ims.interceptors.response.use(function (response) {
			console.log("SUCCESS " + JSON.stringify(response.data));
 	    	return response;
		}, function (error) {
			console.log(JSON.stringify(error));
			if (error.response) {
				console.log("FAILURE " + error.response.status + " - " + JSON.stringify(error.response.data));
			}
	    	return Promise.reject(error);
		});

	return ims;
}

async function getGLS() {
 
    const glsUrl = "https://api.gls.dk/ws/DK/V1/";
    
    var gls = axios.create({
		baseURL: glsUrl,
		validateStatus: function (status) {
		    return status >= 200 && status < 300 || status == 400; // default
		}
	});
	
	gls.interceptors.response.use(function (response) {
			console.log("SUCCESS Status: " + response.status + " Body: " + JSON.stringify(response.data));
 	    	return response;
		}, function (error) {
			if (error.response) {
				console.log("FAILURE " + error.response.status + " - " + JSON.stringify(error.response.data));
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
	
	let gls = await getGLS();

    let response = await ims.get("carriers");
    var carriers = response.data;
    
    let carrier = lookupCarrier(carriers, 'GLS');
    var dataDocument = JSON.parse(carrier.dataDocument);
    var setup = dataDocument.GLSTransport;
    
    response = await ims.get("shipments/" + shipmentId);
    let shipment = response.data;
    
	let glsShipment = new Object();
	
	glsShipment.userName = setup.userName;
	glsShipment.password = setup.password;
	glsShipment.customerId = setup.customerId;
	glsShipment.contactid = setup.contactId;
	glsShipment.shipmentDate = DateTime.local().toFormat('yyyyMMdd');
	glsShipment.reference = shipment.shipmentNumber;
	
	let i = 1;
	let parcels = [];
	let shippingContainers = [];
	shippingContainers = shipment.shippingContainers;
	shippingContainers.forEach(function(shippingContainer) {
		let glsParcel = new Object();
		glsParcel.reference = shipment.shipmentNumber + " #" + i;
		glsParcel.weight = shippingContainer.grossWeight;
		parcels.push(glsParcel);
		i++;
	});
	
	glsShipment.parcels = parcels;
	
	let glsAddresses = new Object();
	
	let contactPerson = shipment.contactPerson;
	
	let glsDeliveryAddress = createGLSAddress(shipment.deliveryAddress, contactPerson);
	
	let senderAddress;
	let senderContactPerson;
    let sellerId = shipment.sellerId;
	if (sellerId != null) {
	    response = await ims.get("sellers/" + sellerId);
		senderAddress = response.data.address;
		senderContactPerson = response.data.contactPerson;
	} else {
		senderAddress = context.address;
		senderContactPerson = context.contactPerson;
	}
	let glsAlternativeShipper = createGLSAddress(senderAddress, senderContactPerson);
	
	glsAddresses.delivery = glsDeliveryAddress;
	glsAddresses.alternativeShipper = glsAlternativeShipper;
	
	glsShipment.addresses = glsAddresses;
	
	let glsServices = new Object();
	if (shipment.pickUpPointId != null) {
		glsServices.shopDelivery = shipment.getPickUpPointId;
	}	
	if (contactPerson != null) {
		glsServices.setNotificationEmail = contactPerson.getEmail;
	}
	let notesOnDelivery = shipment.notesOnDelivery;
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
    
	if (response.status == 400) {
		
		let messageText = "";
		let errorResponse = response.data;
		for (let field in errorResponse.ModelState) {
			messageText = messageText + errorResponse.ModelState[field];
		}
		
		let message = new Object();
		message.time = Date.now();
		message.source = "GLSTransport";
		message.messageType = "ERROR";
		message.messageText = messageText;
		await ims.post("events/" + detail.eventId + "/messages", message);
		
	} else {

	    let glsResponse = response.data;
		let shippingLabel = new Object();
		shippingLabel.base64EncodedContent = glsResponse.PDF;
		shippingLabel.fileName = "SHIPPING_LABEL_" + shipmentId + ".pdf";
		await ims.post("shipments/"+ shipmentId + "/attachments", shippingLabel);
	
		await ims.put("shipments/" + shipmentId + "/consignmentId", glsResponse.consignmentId);
	
		let parcels = glsResponse.Parcels;
		for (let i = 0; i < parcels.length; i++) {
			let shippingContainer = shippingContainers[i];
			let parcel = parcels[i];
			ims.put("shippingContainers/" + shippingContainer.id + "/trackingNumber", parcel.parcelNumber);
		}
		
		let message = new Object();
		message.time = Date.now();
		message.source = "GLSTransport";
		message.messageType = "INFO";
		message.messageText = "Labels are ready";
		await ims.post("events/" + detail.eventId + "/messages", message);

	}

	return "done";

}
