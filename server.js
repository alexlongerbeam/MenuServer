var express = require('express');
var request = require('request');
var cheerio = require('cheerio');
var memjs = require('memjs');


var mc = memjs.Client.create(process.env.MEMCACHE_URL, {
  username: process.env.MEMCACHE_USERNAME,
  password: process.env.MEMCACHE_PASSWORD
}); 




var port = process.env.PORT || 3000;

var baseURL = "http://menu.dining.ucla.edu/Menus/";
var baseHourURL = "http://menu.dining.ucla.edu/Hours/"

var daysToTry = [];
var masterWeek = {};
var masterDay = {};
var masterHours = {};
var mealURL = []; //URLs for each meal for a day, updated for each day as they are iterated through. Global because easier with recursive url requests

var allData = {"halls":Object, "hours":Object}; 

//This is what gets sent to user on request, this is only modified when scrape is complete. This is in JSON String Format
var dataForDownload = "";

var downloadOffLimits = false; //to ensure a user doesn't try to access data while it is being modified

var scrapeUnderway = false; //to prevent two calls to /scrape to trigger at the same time

var app = express(); 




/*

When GET call to '/scrape' is received, daysToTry is populated with the date strings to try,
the dayIterator is called. This iterates in a somewhat recursive fashion through each day.
For each day, the urls of each meal are gathered (put in mealURL[]), and then mealIterator 
iterates through those by calling mealRequest(). Once each meal for a day is scraped, getHours() 
is called to gather the hours of each hall for the current day. Once getHours() is completed, it calls 
dayIterator() to move onto the next day, repeating this process until all days have been scraped.

The control flow is set up in this somewhat recursive way to ensure tasks run in the correct order, 
as normal control flow does not pause to wait for calls to request() to finish.

*/

app.get('/scrape', function(req,res){

	if (scrapeUnderway){
		res.send("Scrape already started");
		return;
	}

	scrapeUnderway = true;

	daysToTry = ["Today", "Tomorrow"];

	//now add a few days in the future
	for (var add = 2; add<=6; add++){
		var newDay =  new Date();
		newDay.setDate(newDay.getDate() + add);

		var month = String((newDay.getMonth()+1));
		var day = String(newDay.getDate());

		if (month.length==1){
			month = "0"+month;
		}

		if (day.length==1){
			day = "0"+day;
		}

		dateString = String(newDay.getFullYear())+"-"+month+"-"+day;
		daysToTry[add] = dateString;
	}

	//Logging purposes below

	console.log("\n\n\n*************Scrape Underway***************");
	var today = new Date();

	var minutes = String(today.getMinutes());

	if (minutes.length == 1){
		minutes = "0" + minutes;
	}

	console.log(String(today.getMonth() + 1) + '-' + today.getDay() + '-' + today.getFullYear() + '\t' + today.getHours() + ':' + minutes);

	console.log("\n\n");
	dayIterator(0);

	res.send("Scrape Underway");
})


app.get('/download', function(req, res) {

	if (!downloadOffLimits){
		if (dataForDownload.length>0){
			res.send(dataForDownload);
		}
		else {
			console.log("Getting from cache");
			mc.get('master', function (err, value, key) {
				if (err!=null){
					console.log(err);
				}
    			if (value != null) {
    				var buf = Buffer.from(value);
        			dataForDownload = buf.toString('utf8');
        			res.send(dataForDownload);
    			}
			});
			
		}
		
	}	
		
})


function mealIterator(index, dateString, dayIndex){
	
	

	if (index==-1){ //start of scraping a new day, populate array of meal URLs
		mealURL = [];
		getMealURL(dateString, dayIndex);
		masterDay = {};
	}
	else if (index>=mealURL.length){
		masterWeek[dateString] = masterDay;
		getHours(dateString, dayIndex);
	}
	else{
		console.log("requesting " + mealURL[index]);
		mealRequest(index, mealURL[index], dayIndex, dateString);
	}
}

function getMealURL(dateString, dayIndex){

	var url = baseURL + dateString;

	request(url, function(error, response, html){

		var meal = new Array();
		if (error){
			console.log(error);
		}
		else{
			var $ = cheerio.load(html);

			$('.meal-detail-link').each(function(i, elm) {

				var urlPart = $(this).children().first().attr('href');
				mealURL[i] = urlPart.substring(7);

			})

		}
		
		mealIterator(0, dateString, dayIndex);

	})

}

function dayIterator(index){
	if (index<daysToTry.length){
		console.log("Starting " + daysToTry[index]);
		mealIterator(-1, daysToTry[index], index);


	}
	else{

		allData["halls"] = masterWeek;
		allData["hours"] = masterHours;

		downloadOffLimits = true;
		dataForDownload = JSON.stringify(allData);
		downloadOffLimits = false;
		var forCache = Buffer.from(dataForDownload, 'utf8');
		mc.set('master', forCache, {expires: 0}, function(err, val) {
			if (err != null){
				console.log(err);
			}
			else{
				console.log("Successfully in cache");
			}
		});

		scrapeUnderway = false;
		console.log("Scrape Complete");
	}

}


function mealRequest(index, url, dayIndex, dateString){

	var completeURL = baseURL + url;
	request (completeURL, function(error, response, html){

		if (error){
			console.log(error);
		}
		else{
			var $ = cheerio.load(html);
			var mealsForHall = {};

			var mealName = $('#page-header').text();

			$('.menu-block').each(function(i, elm) {
				var hallName = $(this).children('h3').text();

				var locationToMeal = {};
				$(this).children('.sect-list').children().each(function(i, elm) {
					var locationName = $(this).text();
					
					var i=1;
					for (i; i<locationName.length; i++){
					if (locationName[i]=='\n'){
						break;
					}
				}

					locationName = locationName.substring(25,i); //25 spaces are placed in front of beginning of location name
					var meals = []; //temp array of meals to be put into dictionary
					$(this).children().first().children().each(function(i, elm){ //gives us a menu-item object
						var oneMeal = []; //will have meal name, description, and URL

						oneMeal[0] = $(this).find('.recipelink').text(); //meal name

						oneMeal[2] = $(this).find('.recipelink').attr('href');
						var description = $(this).find('.tt-description').text();//description
						if (description.length==0){
							description = "No Description Available"
						}
						oneMeal[1] = description;


						meals[i] = oneMeal;
						

					})

					locationToMeal[locationName] = meals;	
				})

				mealsForHall[hallName] = locationToMeal;

			})

			masterDay[mealName] = mealsForHall;

		}

		mealIterator(index+1, dateString, dayIndex);
	})


}



function getHours(dateString, dayIndex){

	url = baseHourURL + dateString;
	console.log("Getting hours for " + dateString);
	request(url, function(error, response, html) {

		if (error){
			console.log(error);
		}
		else{

			var $ = cheerio.load(html);

			var hallToHours = {};

			$('.hours-table').children().first().next().children().each(function(i, elm) { //gives us a <tr> row for the hours table

				var hallName; 
				var hours = [];
				$(this).children().each(function(i, elm) {


					if ($(this).attr('class')== 'hours-head'){
						hallName = $(this).children().first().text();
					}
					else if($(this).attr('class') == 'hours-closed-allday'){
						hours[0] = "CLOSEDALLDAY";
					}
					else if ($(this).attr('class') == 'hours-closed'){

						if ($(this).next().hasClass('Brunch')){
							hours[i-1] = "BRUNCH";
						}
						else{
							hours[i-1] = "Closed";
						}
					}
					else{
						 var hoursString = $(this).children('.hours-range').text();

						 hours[i-1] = hoursString;
					}
				})

				hallToHours[hallName] = hours;

			})

			masterHours[dateString] = hallToHours;
		}
		console.log(dateString + " completed\n\n");
		dayIterator(dayIndex+1);
		
	})


}



app.listen(port);