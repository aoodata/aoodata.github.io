// from stackoverflow https://stackoverflow.com/questions/610406/javascript-equivalent-to-printf-string-format/4673436#4673436
// example "{0} is dead, but {1} is alive! {0} {2}".format("ASP", "ASP.NET")
// First, checks if it isn't implemented yet.
if (!String.prototype.format) {
  String.prototype.format = function() {
    var args = arguments;
    return this.replace(/{(\d+)}/g, function(match, number) {
      return typeof args[number] != 'undefined'
        ? args[number]
        : match
      ;
    });
  };
}

async function aooStats_init() {
    let dbData = {};

    const sqlPromise = initSqlJs({
        locateFile: filename => `/dist/${filename}`
    });
    const dataPromise = fetch("data/" + world + "DB.sqlite").then(res => res.arrayBuffer());
    const [SQL, buf] = await Promise.all([sqlPromise, dataPromise])
    const db = new SQL.Database(new Uint8Array(buf));
    //const res = db.exec("SELECT canonical_name FROM commanders order by canonical_name");
    //console.log('Here is a row: ' + JSON.stringify(res));

    dbData["db"] = db;

    function formatScore(score) {
        // add commas to the score
        return score.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function formatDate(date) {
        // format date to dd.mm.yyyy
        return date.getDate() + "/" + (date.getMonth() + 1) + "/" + date.getFullYear();
    }

    /**
     * Get the list of all alliances
     * @returns {{number: {id: number, name: string, name_long: string, aliases: {name: string[]}} }} dict of all alliances by alliance id
     */
    function getAlliances() {
        const req = db.exec("SELECT id, name_short, name_long FROM alliances")[0]["values"];
        let alliances = {};
        for (let i = 0; i < req.length; i++) {
            // we add the name_long as an alias for compatibility with commander data
            alliances[req[i][0]] = {
                "id": req[i][0],
                "name": req[i][1],
                "name_long": req[i][2],
                "aliases": {"name": [req[i][2]]}
            };
        }
        return alliances;
    }

    dbData["alliances"] = getAlliances();

    /**
     * Get the list of all commanders
     * @param alliances list of all alliances
     * @returns {{number: {id: number, name: string, aliases: {name: string, date: Date}[], alliance: {id: number, name: string, name_long: string, aliases: {name: string}[]}} }} dict of all commanders by commander id
     */
    function getCommanders(alliances) {
        const req = db.exec("SELECT id, canonical_name, alliance_id FROM commanders")[0]["values"];
        let commanders = {};
        for (let i = 0; i < req.length; i++) {
            commanders[req[i][0]] = {
                "id": req[i][0],
                "name": req[i][1],
                "alliance": alliances[req[i][2]]
            };
        }

        //get aliases
        let req2 = db.exec("SELECT commander_id, name, date FROM commander_names")[0];
        if (req2 !== undefined){
            req2 = req2["values"];
            for (let i = 0; i < req2.length; i++) {
                commanders[req2[i][0]]["aliases"] = commanders[req2[i][0]]["aliases"] || [];
                commanders[req2[i][0]]["aliases"].push({"name": req2[i][1], "date": new Date(req2[i][2] * 1000)});
            }
        }

        return commanders;
    }

    dbData["commanders"] = getCommanders(dbData["alliances"]);

    /**
     * Get the data collection types
     * @returns {{string: number}} the data collection type id for each collection type
     */
    function getDataCollectionTypes() {
        const req = db.exec("SELECT id, name FROM data_collection_types")[0]["values"];
        let dataCollectionsTypes = {};
        for (let i = 0; i < req.length; i++) {
            dataCollectionsTypes[req[i][1]] = req[i][0];
        }
        return dataCollectionsTypes;
    }

    dbData["dataCollectionTypes"] = getDataCollectionTypes();

    /**
     * Get the latest data collection id for each collection type
     * @returns {{string: {id: number, date: Date}}} the latest data collection id for each collection type
     */
    function latestDataCollection() {
        let latestDataCollection = {};
        for (const [key, value] of Object.entries(dbData["dataCollectionTypes"])) {
            const req = db.exec("SELECT id, date FROM data_collections WHERE type_id = " + value + " ORDER BY date DESC LIMIT 1");
            if (req.length > 0) {
                const line = req[0]["values"][0];
                latestDataCollection[key] = {"id": line[0], "date": new Date(line[1] * 1000)};
            }
        }
        return latestDataCollection;
    }

    dbData["latestDataCollection"] = latestDataCollection();

    /**
     * Process the data returned by the SQL query for alliance or commander scores
     *
     * @param req the SQL query result with values and dates
     * @returns {{scores: number[], dates: Date[], ranks: number[]}} data to be used in the chart
     */
    function processAllianceCommanderScores(req) {
        if (req.length === 0) {
            return {"scores": [], "dates": [], "ranks": []};
        }
        req = req[0]["values"];
        let scores = [];
        let dates = [];
        let ranks = [];
        for (let i = 0; i < req.length; i++) {
            scores.push(req[i][0]);
            // convert the date from unix timestamp to Date object, keep only the day, month and year (not the time) and add it to the dates array
            let date = new Date(req[i][1] * 1000);
            date.setHours(0, 0, 0, 0);
            dates.push(date);
            ranks.push(req[i][2]);
        }
        return {"scores": scores, "dates": dates, "ranks": ranks};
    }

    /**
     * Get the scores of a commander for a given data collection type
     * @param commanderId the commander id
     * @param dataCollectionType the data collection type
     * @param limit the number of scores to return
     * @returns {{scores: number[], dates: Date[]}} data to be used in the chart
     */
    dbData.getCommanderScores = function (commanderId, dataCollectionType, limit=1000) {
        let dataCollectionTypeId = dbData["dataCollectionTypes"][dataCollectionType];
        let req = db.exec("SELECT value, date, rank FROM commander_ranking_data, data_collections WHERE data_collections.id = commander_ranking_data.data_collection_id AND commander_ranking_data.commander_id = " + commanderId + " AND type_id = " + dataCollectionTypeId + " ORDER BY date DESC LIMIT " + limit);
        return processAllianceCommanderScores(req)
    }

    /**
     * Get the list of commanders with the highest score for a given data collection type
     * @param dataCollectionType the data collection type
     * @param limit the number of commanders to return
     * @param order the order ("ASC" or "DESC")
     * @returns {number[]} the list of commanders IDs
     */
    dbData.getHighestRankedCommanders = function (dataCollectionType, limit, order="DESC") {
        if (!(dataCollectionType in dbData["latestDataCollection"])) {
            return [];
        }
        const latestDataCollectionId = dbData["latestDataCollection"][dataCollectionType]["id"];
        const req = db.exec("SELECT commander_id FROM commander_ranking_data WHERE data_collection_id = " + latestDataCollectionId + " ORDER BY value " + order + " LIMIT " + limit)[0]["values"];
        let commanders = [];
        for (let i = 0; i < req.length; i++) {
            commanders.push(req[i][0]);
        }
        return commanders;
    }

    /**
     * Get the scores of an alliance for a given data collection type
     * @param allianceId the alliance id
     * @param dataCollectionType the data collection type
     * @param limit the number of scores to return
     * @returns {{scores: number[], dates: Date[]}} data to be used in the chart
     */
    dbData.getAllianceScores = function (allianceId, dataCollectionType, limit=1000) {
        let dataCollectionTypeId = dbData["dataCollectionTypes"][dataCollectionType];
        let req = db.exec("SELECT value, date, rank FROM alliance_ranking_data, data_collections WHERE data_collections.id = alliance_ranking_data.data_collection_id AND alliance_ranking_data.alliance_id = " + allianceId + " AND type_id = " + dataCollectionTypeId + " ORDER BY date DESC LIMIT " + limit);
        return processAllianceCommanderScores(req)
    }

    /**
     * Get the list of alliances with the highest score for a given data collection type
     * @param dataCollectionType the data collection type
     * @param limit the number of alliances to return
     * @param order the order ("ASC" or "DESC")
     * @returns {number[]} the list of alliances IDs
     */
    dbData.getHighestRankedAlliances = function (dataCollectionType, limit, order="DESC") {
        if (!(dataCollectionType in dbData["latestDataCollection"])) {
            return [];
        }
        const latestDataCollectionId = dbData["latestDataCollection"][dataCollectionType]["id"];
        const req = db.exec("SELECT alliance_id FROM alliance_ranking_data WHERE data_collection_id = " + latestDataCollectionId + " ORDER BY value " + order + " LIMIT " + limit)[0]["values"];
        let alliances = [];
        for (let i = 0; i < req.length; i++) {
            alliances.push(req[i][0]);
        }
        return alliances;
    }

    /**
     * Get all strongest commander results
     * @param event_type the event type (void or frenzy)
     * @returns {{ opponent: number, opponent_score: number, nation_score: number, date: Date }[]} the list of results
     */
    dbData.getVoidFrenzyEvents = function (event_type) {
        let req = db.exec("SELECT opponent, opponent_score, nation_score, date FROM " + event_type + " ORDER BY date DESC");
        if (req.length === 0) {
            return [];
        }
        req = req[0]["values"];
        let res = [];
        for (let i = 0; i < req.length; i++) {
            res.push({
                "opponent": req[i][0],
                "opponent_score": req[i][1],
                "nation_score": req[i][2],
                "date": new Date(req[i][3] * 1000)
            });
        }
        return res;
    }

    dbData.referenceStrongestCommanderEventDate = new Date(2023, 0, 29);
    dbData.referenceStrongestCommanderEventType = "void";

    /**
     * Get the date of the strongest commander event from a cycle number
     * @param cycle_number the cycle number
     * @returns {{date: Date, type: (string)}} the date of the event and the type of the event (void or frenzy)
     */
    dbData.getStrongestCommanderEventFromCycleNumber = function (cycle_number) {
        const days = cycle_number * 14;
        const date = new Date(dbData.referenceStrongestCommanderEventDate.getTime() + days * 24 * 60 * 60 * 1000);
        return {
            "date": date,
            "type": (cycle_number % 2 === 0 ? dbData.referenceStrongestCommanderEventType : (dbData.referenceStrongestCommanderEventType === "void" ? "frenzy" : "void")),
            "cycle_number": cycle_number,
        };
    }

    /**
     * Get the date of the first strongest commander event before a given date
     * @param date the date
     * @param event_type the event type (void or frenzy)
     * @returns {{date: Date, type: (string), cycle_number: number}} the date of the event, the type of the event and the number of SC cycles since the reference event
     */
    dbData.getDateOfFirstStrongestCommanderEventBefore = function (date, event_type) {
        date = date || new Date();
        event_type = event_type || "any";

        // number of days between date and the reference event date
        const days = Math.floor((date - dbData.referenceStrongestCommanderEventDate) / (1000 * 60 * 60 * 24));
        // number of events between date and the reference event date
        const events = Math.floor(days / 14);
        // number of days between the reference event date and the event we want to find
        const daysBefore = events * 14;
        // date of the event we want to find
        const eventDate = new Date(dbData.referenceStrongestCommanderEventDate.getTime() + daysBefore * 24 * 60 * 60 * 1000);
        // type of the event we want to find
        const eventType = (events % 2 === 0) ? dbData.referenceStrongestCommanderEventType : (dbData.referenceStrongestCommanderEventType === "void" ? "frenzy" : "void");
        if (event_type === "any") {
            return {date: eventDate, type: eventType, cycle_number: events};
        } else if (event_type === eventType) {
            return {date: eventDate, type: eventType, cycle_number: events};
        } else {
            // 14 days before the event we found
            const previousEventDate = new Date(eventDate.getTime() - 14 * 24 * 60 * 60 * 1000);
            return {date: previousEventDate, type: event_type, cycle_number: events};
        }
    }

    /**
     * Get all strongest commander results for void events
     * @returns {{ opponent: number, opponent_score: number, nation_score: number, date: Date }[]} the list of results
     */
    dbData.getVoidEvents = function () {
        return dbData.getVoidFrenzyEvents("void");
    }

    /**
     * Get all strongest commander results for frenzy events
     * @returns {{ opponent: number, opponent_score: number, nation_score: number, date: Date }[]} the list of results
     */
    dbData.getFrenzyEvents = function () {
        return dbData.getVoidFrenzyEvents("frenzy");
    }

    /**
     * Get all strongest commander results for void and frenzy events
     * @returns {{ opponent: number, opponent_score: number, nation_score: number, date: Date, type: string }[]} the list of results (type is frenzy or void)
     */
    dbData.getStrongestCommanderEvents = function () {
        // merge void and frenzy events sorted by date
        let voidEvents = dbData.getVoidEvents();
        let frenzyEvents = dbData.getFrenzyEvents();
        let events = [];
        let i = 0;
        let j = 0;
        while (i < voidEvents.length && j < frenzyEvents.length) {
            if (voidEvents[i].date > frenzyEvents[j].date) {
                events.push(voidEvents[i]);
                events[events.length - 1].type = "void";
                i++;
            } else {
                events.push(frenzyEvents[j]);
                events[events.length - 1].type = "frenzy";
                j++;
            }
        }
        while (i < voidEvents.length) {
            events.push(voidEvents[i]);
            events[events.length - 1].type = "void";
            i++;
        }
        while (j < frenzyEvents.length) {
            events.push(frenzyEvents[j]);
            events[events.length - 1].type = "frenzy";
            j++;
        }
        return events;
    }

    /**
     * Get the name of the rank corresponding to the given number of merit points
     * @param merite_points
     * @returns {string}
     */
    dbData.getMeritRankName = function(merit_points){
        const intervals = [1300,4300,11300,25300,51300,91300,147300,222300,322300,452300,617300,822300];
        const ranks = ["Private","Private First Class","Sergeant","Master Sergeant","Warrant Officer",
            "Second Lieutenant","First Lieutenant","Captain","Major","Lieutenant Colonel","Colonel","Brigadier","General"];
        for(let i = 0; i < intervals.length; i++){
            if(merit_points < intervals[i]){
                return ranks[i];
            }
        }
        return ranks[ranks.length - 1];
    }

    /**
     * Get the data collection id of the first data collection after the given date
     * @param date  the date
     * @param rankingName the name of the ranking
     * @param after if true, get the first data collection after the given date, else get the first data collection before the given date
     * @returns {{id: number, date: Date}} the id of the data collection and the date of the data collection
     */
    dbData.getFirstDataCollectionIdNearDate = function(date, rankingName, after = true){
        let sign = after ? ">= " : "<= ";
        let ord = after ? "ASC" : "DESC";
        let req = db.exec("SELECT id, date FROM data_collections WHERE type_id = " + dbData.dataCollectionTypes[rankingName] + " AND date " + sign  + date / 1000 + " ORDER BY date " + ord + " LIMIT 1");
        if(req.length === 0){
            return undefined;
        }
        req = req[0]["values"][0];
        return {id:req[0], date: new Date(req[1] * 1000)};
    }

    /**
     * Get the first commander ranking after the given date
     * @param date the date
     * @param rankingName the name of the ranking
     * @param after if true, get the first ranking after the given date, else get the first ranking before the given date
     * @returns {{number: number}} commander id -> value
     */
    dbData.getCommanderRankingNearDate = function(date, rankingName, after = true){

        const dataCollectionId = dbData.getFirstDataCollectionIdNearDate(date, rankingName, after);
        if (dataCollectionId === undefined) {
            return {};
        }

        req = db.exec("SELECT commander_id, value FROM commander_ranking_data WHERE data_collection_id = " + dataCollectionId.id)[0]["values"];
        let ranking = {};
        for(let i = 0; i < req.length; i++){
            ranking[req[i][0]] = req[i][1];
        }
        return ranking;
    }

    /**
     * Get the maximum ranking score
     * @param rankingName the name of the ranking
     * @returns {number} the maximum score
     */
    dbData.getMaxRankingScore = function(rankingName){
        let req;
        if (rankingName.startsWith("commander_")) {
            req = db.exec("SELECT max(value) FROM commander_ranking_data, data_collections WHERE commander_ranking_data.data_collection_id = data_collections.id and type_id = " + dbData.dataCollectionTypes[rankingName])[0]["values"];
        } else if (rankingName.startsWith("alliance_")) {
            req = db.exec("SELECT max(value) FROM alliance_ranking_data, data_collections WHERE alliance_ranking_data.data_collection_id = data_collections.id and type_id = " + dbData.dataCollectionTypes[rankingName])[0]["values"];
        } else {
            throw "Invalid ranking name";
        }

        if(req.length === 0){
            return 0;
        }
        return req[0][0];
    }

    /**
     * Get the maximum ranking score for all rankings
     * @returns {{rankingName: number}} ranking name -> maximum score
     */
    function getMaxRankingScores(){
        let scores = {};
        for(let rankingName in dbData.dataCollectionTypes){
            scores[rankingName] = dbData.getMaxRankingScore(rankingName);
        }
        return scores;
    }

    dbData.maxRankingScores = getMaxRankingScores();

    /**
     * Get the maximum commander ranking before the first collection after the given date
     * @param date the date
     * @param rankingName the name of the ranking
     * @returns {{number: number}} commander id -> value
     */
    dbData.getMaxCommanderRankingBeforeDate = function(date, rankingName){
        const refDataCollection = dbData.getFirstDataCollectionIdNearDate(date, rankingName);
        if (refDataCollection === undefined) {
            return {};
        }
        let req = db.exec("SELECT commander_id, max(value) FROM commander_ranking_data, data_collections WHERE commander_ranking_data.data_collection_id = data_collections.id and type_id = " + dbData.dataCollectionTypes[rankingName] + " AND date <= " + (refDataCollection.date / 1000 + 1000) + " GROUP BY commander_id");
        if(req.length === 0){
            return [];
        }
        req = req[0]["values"];

        let ranking = {};
        for(let i = 0; i < req.length; i++){
            ranking[req[i][0]] = req[i][1];
        }
        return ranking;
    }

    /**
     * Get the evolution of the commander rankings during a cycle
     * @param rankingName the name of the ranking
     * @param cycleNumber the number of the cycle (optional, default is the previous cycle)
     * @param takeMaxRanking if true, take the maximum ranking instead of the first ranking
     * @param filterUnchanged if true, filter out commanders that have the same ranking in both cycles
     * @returns {{commander: commander_entry, old_score: number, new_score:number}[]}
     */
    dbData.getCommanderRankingEvolutionDuringCycle = function(rankingName, cycleNumber, takeMaxRanking=false, filterUnchanged=true, short=false){
        if (cycleNumber === undefined) {
            cycleNumber = dbData.getDateOfFirstStrongestCommanderEventBefore(new Date()).cycle_number;
        }

        let secondDate = dbData.getStrongestCommanderEventFromCycleNumber(cycleNumber).date;
        let firstDate = (short)?secondDate:
            dbData.getStrongestCommanderEventFromCycleNumber(cycleNumber - 1).date;

        let firstRanking;
        let secondRanking;
        if(takeMaxRanking){
            firstRanking = dbData.getMaxCommanderRankingBeforeDate(firstDate, rankingName);
            secondRanking = dbData.getMaxCommanderRankingBeforeDate(secondDate, rankingName);
        } else {
            firstRanking = (short)? dbData.getCommanderRankingNearDate(firstDate, rankingName, false):
                dbData.getCommanderRankingNearDate(firstDate, rankingName);
            secondRanking = dbData.getCommanderRankingNearDate(secondDate, rankingName);
        }

        let rankingChanges = [];
        for(let commanderId in firstRanking){
            if(commanderId in secondRanking && (!filterUnchanged || firstRanking[commanderId] !== secondRanking[commanderId])){
                rankingChanges.push({
                    commander: dbData.commanders[commanderId],
                    old_score: firstRanking[commanderId],
                    new_score: secondRanking[commanderId]}
                );
            }
        }

        return rankingChanges;
    }

    dbData.newsWidget = (function () {
        function newsWidget(rootElement) {

            let currentCycle = dbData.getDateOfFirstStrongestCommanderEventBefore();

            function formatTitle(cycle){
                // startDate is cycle date minus 13 days
                let startDate = new Date(cycle.date);
                startDate.setDate(startDate.getDate() - 13);

                if (cycle.type === "void") {
                    return translator.translate("Void cycle update") + " (" + formatDate(startDate) + " ➜ " + formatDate(cycle.date) + ")";
                } else {
                    return translator.translate("Frenzy cycle update") + " (" + formatDate(startDate) + " ➜ " + formatDate(cycle.date) + ")";
                }
            }


            let modalHeader = document.createElement("div");
            modalHeader.className = "modal-header";
            let modalTitleBar = document.createElement("h5");
            modalTitleBar.className = "modal-title";
            modalTitleBar.style.textAlign = "center";
            modalTitleBar.style.width = "100%";
            modalHeader.appendChild(modalTitleBar);



            let modalTitle = document.createElement("span");
            modalTitle.innerText = formatTitle(currentCycle);
            modalTitleBar.appendChild(modalTitle);



            let modalCloseButton = document.createElement("button");
            modalCloseButton.className = "btn-close";
            modalCloseButton.setAttribute("data-bs-dismiss", "modal");
            modalCloseButton.setAttribute("aria-label", "Close");
            modalHeader.appendChild(modalCloseButton);
            rootElement.appendChild(modalHeader);

            let mainDiv = document.createElement("div");
            mainDiv.className = "modal-body";
            rootElement.appendChild(mainDiv);

            let previousCycleButton = document.createElement("span");
            previousCycleButton.innerHTML = "❰";
            previousCycleButton.style.cursor = "pointer";
            previousCycleButton.style.position = "sticky";
            previousCycleButton.style.left = "5px";
            previousCycleButton.style.top = "calc(50% - 0.75em)";
            previousCycleButton.style.fontSize = "200%";
            previousCycleButton.style.fontWeight = "bold";
            previousCycleButton.style.zIndex = "1";
            previousCycleButton.color = "#03401c";
            previousCycleButton.onclick = function(){
                currentCycle = dbData.getStrongestCommanderEventFromCycleNumber(currentCycle.cycle_number - 1);
                modalTitle.innerText = formatTitle(currentCycle);
                updateNews();
            }
            mainDiv.appendChild(previousCycleButton);

            let nextCycleButton = document.createElement("span");
            //nextCycleButton.className = "btn";
            nextCycleButton.innerHTML = "❱";
            nextCycleButton.style.cursor = "pointer";
            nextCycleButton.style.position = "sticky";
            nextCycleButton.style.left = "100%";
            nextCycleButton.style.top = "calc(50% - 0.75em)";
            nextCycleButton.style.fontSize = "200%";
            nextCycleButton.style.fontWeight = "bold";
            nextCycleButton.style.zIndex = "1";
            nextCycleButton.color = "#03401c";
            nextCycleButton.onclick = function(){
                currentCycle = dbData.getStrongestCommanderEventFromCycleNumber(currentCycle.cycle_number + 1);
                modalTitle.innerText = formatTitle(currentCycle);
                updateNews();
            }
            mainDiv.appendChild(nextCycleButton);

            let newsDiv = document.createElement("div");
            newsDiv.style.textAlign = "center";
            newsDiv.style.listStylePosition = "inside";
            newsDiv.style.marginTop = "-2.5em";
            mainDiv.appendChild(newsDiv);

            let copyButton = document.createElement("div");
            copyButton.innerText = "📋";
            copyButton.style.textAlign = "center";
            copyButton.style.cursor = "pointer";
            mainDiv.appendChild(copyButton);

            copyButton.onclick = function(){
                let text = newsToPlainText();
                navigator.clipboard.writeText(text);
            }

            function getCommandersWithHighKillNumberDiv(numberOfCommanders=10){
                var data;
                if (currentCycle.type === "void") {
                    data = dbData.getCommanderRankingEvolutionDuringCycle("commander_kill", currentCycle.cycle_number, false, true,true);
                } else{
                    data = dbData.getCommanderRankingEvolutionDuringCycle("commander_kill", currentCycle.cycle_number);
                }
                if (data.length === 0) {
                    return undefined;
                }
                for(let i = 0; i < data.length; i++){
                    data[i]["kills"] = data[i].new_score - data[i].old_score;
                }

                data.sort(function(a, b){
                    return b.kills - a.kills;
                });

                let news = document.createElement("div");
                let title = document.createElement("h3");
                if (currentCycle.type === "void") {
                    title.innerHTML = translator.translate("Top void killers");
                } else {
                    title.innerHTML = translator.translate("Top killers");
                }
                news.appendChild(title);
                let list = document.createElement("ol");
                list.style.paddingLeft = "0";
                for(let i = 0; i < numberOfCommanders && i < data.length; i++){
                    let li = document.createElement("li");
                    li.innerHTML = translator.translate("name : xxx kills").format(data[i].commander.name, formatScore(data[i].kills));
                    list.appendChild(li);
                }
                news.appendChild(list);
                return news;
            }

            function getCommandersWithMeritPromotionDiv(numberOfCommanders=10){
                let data = dbData.getCommanderRankingEvolutionDuringCycle("commander_merit", currentCycle.cycle_number);
                if (data.length === 0) {
                    return undefined;
                }
                let filteredData = [];
                for(let i = 0; i < data.length; i++){
                    let newMeriteRank = dbData.getMeritRankName(data[i].new_score);
                    let oldMeriteRank = dbData.getMeritRankName(data[i].old_score);
                    if(newMeriteRank !== oldMeriteRank){
                        data[i]["merit_rank"] = newMeriteRank;
                        filteredData.push(data[i]);
                    }
                }

                if (filteredData.length === 0) {
                    return undefined;
                }

                filteredData.sort(function(a, b){
                    return b.new_score - a.new_score;
                });

                let news = document.createElement("div");
                let title = document.createElement("h3");
                title.innerHTML = translator.translate("Promotions");
                news.appendChild(title);
                let list = document.createElement("ol");
                list.style.paddingLeft = "0";
                for(let i = 0; i < numberOfCommanders && i < filteredData.length; i++){
                    let li = document.createElement("li");
                    li.innerHTML = translator.translate("name : merit_rank").format(filteredData[i].commander.name, translator.translate(filteredData[i].merit_rank));
                    list.appendChild(li);
                }
                news.appendChild(list);
                return news;
            }

            function getCommandersWithCityLevelUpgradeDiv(numberOfCommanders=20){
                let data = dbData.getCommanderRankingEvolutionDuringCycle("commander_city", currentCycle.cycle_number, true);
                if (data.length === 0) {
                    return undefined;
                }

                data.sort(function(a, b){
                    return b.new_score - a.new_score;
                });

                let news = document.createElement("div");
                let title = document.createElement("h3");
                title.innerHTML = translator.translate("City level upgrade");
                news.appendChild(title);
                let list = document.createElement("ol");
                list.style.paddingLeft = "0";
                for(let i = 0; i < numberOfCommanders && i < data.length; i++){
                    let li = document.createElement("li");
                    li.innerHTML = translator.translate("name : city_level").format(data[i].commander.name, data[i].new_score);
                    list.appendChild(li);
                }
                news.appendChild(list);
                return news;
            }

            function getCommandersWithRankingStepUpDiv(mode){
                let stepSize, ranking_name, formatString, newstitle, minvalue;
                if(mode === "officer"){
                    stepSize = 500000;
                    minvalue = 0;
                    ranking_name = "commander_officer";
                    formatString = translator.translate("name reached xxx officer power");
                    newstitle = translator.translate("Officer power");
                } else if(mode === "titan"){
                    stepSize = 100000;
                    minvalue = 0;
                    ranking_name = "commander_titan";
                    formatString = translator.translate("name reached xxx titan power");
                    newstitle = translator.translate("Titan power");
                } else if(mode === "warplane"){
                    stepSize = 25000;
                    minvalue = 450000;
                    ranking_name = "commander_warplane";
                    formatString = translator.translate("name reached xxx warplane power");
                    newstitle = translator.translate("Warplane power");
                }
                let data = dbData.getCommanderRankingEvolutionDuringCycle(ranking_name, currentCycle.cycle_number, true);
                if (data.length === 0) {
                    return undefined;
                }
                let filteredData = [];
                for(let i = 0; i < data.length; i++){
                    if(data[i].new_score < minvalue){
                        continue;
                    }
                    let newStep = Math.floor(data[i].new_score / stepSize);
                    let oldStep = Math.floor(data[i].old_score / stepSize);
                    if(newStep > oldStep){
                        data[i]["officer_step"] = newStep;
                        filteredData.push(data[i]);
                    }
                }
                if (filteredData.length === 0) {
                    return undefined;
                }
                filteredData.sort(function(a, b){
                    return b.new_score - a.new_score;
                }  );

                let news = document.createElement("div");
                let title = document.createElement("h3");
                title.innerHTML = newstitle;
                news.appendChild(title);
                let list = document.createElement("ol");
                list.style.paddingLeft = "0";
                for(let i = 0; i < filteredData.length; i++){
                    let li = document.createElement("li");
                    //li.innerHTML = filteredData[i].commander.name + " reached " + formatScore(filteredData[i].officer_step * stepSize) + " officer power";
                    li.innerHTML = formatString.format(filteredData[i].commander.name, formatScore(filteredData[i].officer_step * stepSize));
                    list.appendChild(li);
                }

                news.appendChild(list);
                return news;
            }

            function updateNews(){
                newsDiv.innerHTML = "";

                let cityLevelUpgradeNews = getCommandersWithCityLevelUpgradeDiv();
                if(cityLevelUpgradeNews !== undefined){
                    newsDiv.appendChild(cityLevelUpgradeNews);
                }

                let officerStepUpNews = getCommandersWithRankingStepUpDiv("officer");
                if(officerStepUpNews !== undefined){
                    newsDiv.appendChild(officerStepUpNews);
                }

                let titanStepUpNews = getCommandersWithRankingStepUpDiv("titan");
                if(titanStepUpNews !== undefined){
                    newsDiv.appendChild(titanStepUpNews);
                }

                let warplaneStepUpNews = getCommandersWithRankingStepUpDiv("warplane");
                if(warplaneStepUpNews !== undefined){
                    newsDiv.appendChild(warplaneStepUpNews);
                }

                let promotionNews = getCommandersWithMeritPromotionDiv();
                if(promotionNews !== undefined){
                    newsDiv.appendChild(promotionNews);
                }

                let killNews = getCommandersWithHighKillNumberDiv();
                if(killNews !== undefined){
                    newsDiv.appendChild(killNews);
                }
                if (newsDiv.children.length === 0) {
                    let title = document.createElement("h3");
                    title.innerHTML = translator.translate("No data for this cycle");
                    newsDiv.appendChild(title);
                }
            }

            function newsToPlainText(){
                let text = "";
                for(let i = 0; i < newsDiv.children.length; i++){
                    let newsItem = newsDiv.children[i];
                    let title = newsItem.getElementsByTagName("h3")[0];
                    text += "[b]" + title.innerText + "[/b]\n";

                    let listitems = newsItem.getElementsByTagName("li");
                    for(let j = 0; j < listitems.length; j++){
                        text += (j+1) + ". " + listitems[j].innerText + "\n";
                    }
                    text += "\n";
                }
                return text;
            }

            updateNews();

        }
        return newsWidget;
    }());

    /**
     * Create a widget holding information of all strongest commander events and add it to the given DOM element
     * @type {strongestCommanderWidget}
     */
    dbData.strongestCommanderEventWidget = (function () {
        function strongestCommanderWidget(rootElement) {
            this.rootElement = rootElement;



            let strongestCommanderEvents = dbData.getStrongestCommanderEvents();
            // create table for strongest commander events
            let strongestCommanderTableDiv = document.createElement("div");
            strongestCommanderTableDiv.className = "table-responsive";
            let strongestCommanderTable = document.createElement("table");
            strongestCommanderTable.className = "table table-striped table-bordered table-hover table-sm";
            strongestCommanderTable.style.marginTop = "20px";
            strongestCommanderTable.innerHTML = "<thead><tr>" +
                "<th>" + translator.translate("Event") + "</th>" +
                "<th>" + translator.translate("Date") + "</th>" +
                "<th>" + translator.translate("Opponent") + "</th>" +
                "<th>" + translator.translate("Opponent score") + "</th>" +
                "<th>" + translator.translate("Nation score") + "</th>" +
                "<th>" + translator.translate("Result") + "</th>" +
                "</tr></thead>" +
                "<tbody></tbody>";
            let strongestCommanderTableBody = strongestCommanderTable.getElementsByTagName("tbody")[0];
            for (let i = 0; i < strongestCommanderEvents.length; i++) {
                let event = strongestCommanderEvents[i];
                let row = document.createElement("tr");
                row.innerHTML = "<td>" + translator.translate(event.type) + "</td>" +
                    "<td>" + formatDate(event.date) + "</td>" +
                    "<td>" + event.opponent + "</td>" +
                    "<td>" + formatScore(event.opponent_score) + "</td>" +
                    "<td>" + formatScore(event.nation_score) + "</td>" +
                    "<td>" + ((event.nation_score >= event.opponent_score) ? translator.translate("Win") : translator.translate("Lost")) + "</td>";
                strongestCommanderTableBody.appendChild(row);
            }
            strongestCommanderTableDiv.appendChild(strongestCommanderTable);
            rootElement.appendChild(strongestCommanderTableDiv);
        }

        return strongestCommanderWidget;
    }());

    /**
     * Create a widget holding information of command or alliances rankings and add it to the given DOM element
     * @type {rankingWidget}
     */
    dbData.rankingWidget = (function () {

        function rankingWidget(divId, rankingName, aooStats, nameDict, mode) {
            // mode can be "commander" or "alliance" or "commanderProfile"
            this.mode = mode || "commander";
            // provides access to the aoo stats
            this.aooStats = aooStats;
            // current ranking displayed
            this.rankingName = rankingName;
            // container element
            this.rootDomElement = document.getElementById(divId);
            // entries displayed in the ranking {{number: string}} (number is the entry id and string is the associated color in the chart)
            this.focusedEntries = {}
            // set of colors used in the chart (used to avoid using the same color twice)
            this.usedColors = new Set();
            // display ranks or scores
            this.displayMode = "scores";

            this.isDisplayRanks = function(){
                return !rankings_without_ranks.has(this.rankingName) && this.displayMode === "ranks";
            }

            let colorsArray = [
                "#0bb4ff",
                "#50e991",
                "#e6d800",
                "#9b19f5",
                "#ffa300",
                "#dc0ab4",
                "#b3d4ff",
                "#00bfa0",
                "#a79f00",
                "#6856ff",
                "#00cd3a",
                "#3500a0",
                "#e60049",
                "#ff7000",
                "#1693ff",
                "#005cb4",
                "#326000",
                "#63006c",
                "#423900",
                "#edb1fd",
                "#5c0019",
                "#9caace",
                "#ff679d",
                "#003f71",
                "#edbbac",
                "#421140"];

            let commander_rankings = [
                "commander_power",
                "commander_kill",
                "commander_city",
                "commander_officer",
                "commander_titan",
                "commander_warplane",
                "commander_island",
                "commander_merit",
                "commander_level",
                "commander_reputation",
                "commander_loss",
                "commander_ke_frenzy",
                "commander_sc_frenzy",
                "commander_ke_void",
                "commander_sc_void",]

            let alliance_rankings = [
                "alliance_power",
                "alliance_kill",
                "alliance_territory",
                "alliance_elite",
                "alliance_sc_frenzy",
                "alliance_sc_void",]

            let ranking_lists = {
                "commander": commander_rankings,
                "alliance": alliance_rankings,
                "commanderProfile": commander_rankings,
                "allianceProfile": alliance_rankings
            }

            let rankings_without_ranks = new Set(["commander_reputation", "commander_loss"]);

            /***********************************
             * Create graph control row
             ***********************************/
            let graphCommandsRow = document.createElement("div");
            graphCommandsRow.style.margin_bottom = "20px";
            graphCommandsRow.style.textAlign = "left";
            graphCommandsRow.style.paddingLeft = "20px";
            graphCommandsRow.style.paddingRight = "20px";
            graphCommandsRow.style.position = "relative";
            this.rootDomElement.appendChild(graphCommandsRow)

            // ------------------ Ranking selection ------------------
            // create dropdown menu for ranking selection
            if (this.mode !== "commanderProfile" && this.mode !== "allianceProfile"){
                graphCommandsRow.innerHTML =
                    '<span style="font-size: 120%;font-weight: bold;vertical-align: middle">' + translator.translate("Ranking: ") + '</span>' +
                    '<div class="dropdown" style="display: inline-block; ">\n' +
                    '  <button class="btn dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">\n' +
                    translator.translate(this.rankingName) +
                    '  </button>\n' +
                    '  <ul class="dropdown-menu"></ul>' +
                    '</div>'

                let rankingNameButton = graphCommandsRow.getElementsByClassName("btn")[0];
                let dropdownMenu = graphCommandsRow.getElementsByClassName("dropdown-menu")[0];
                for (let i = 0; i < ranking_lists[this.mode].length; i++) {
                    let dropdownItem = document.createElement("li");
                    dropdownItem.innerHTML = '<span class="dropdown-item" style="cursor: pointer" data-name="' + ranking_lists[this.mode][i] + '">' + translator.translate(ranking_lists[this.mode][i]) + '</span>';
                    if (ranking_lists[this.mode][i] === rankingName) {
                        dropdownItem.children[0].classList.add("active");
                    }
                    dropdownMenu.appendChild(dropdownItem);
                }

                let dropdownItems = graphCommandsRow.getElementsByClassName("dropdown-item");
                for (let i = 0; i < dropdownItems.length; i++) {
                    dropdownItems[i].addEventListener("click", function () {
                        this.setRankingName(dropdownItems[i].dataset.name);
                        // change active class
                        for (let j = 0; j < dropdownItems.length; j++) {
                            dropdownItems[j].classList.remove("active");
                        }
                        dropdownItems[i].classList.add("active");
                        rankingNameButton.innerHTML = dropdownItems[i].innerHTML;
                        if (rankings_without_ranks.has(dropdownItems[i].dataset.name)) {
                            // disable rankswitch
                            this.switchInput.disabled = true;
                        } else {
                            this.switchInput.disabled = false;
                        }
                    }.bind(this));
                }
            }

             // ------------------- Score/Rank switch -------------------
            if (this.mode !== "commanderProfile" && this.mode !== "allianceProfile") {
                let switchDIV = document.createElement("div");
                switchDIV.style.display = "inline-block";
                switchDIV.style.paddingLeft = "20px";
                switchDIV.innerHTML =
                    '<span  style="font-size: 120%;font-weight: bold; vertical-align: middle;">' + translator.translate("Ranks:") + '</span>' +
                    '<div class="form-check form-switch" style="vertical-align: middle; display: inline-block; padding-left: 50px;">' +
                    '<input class="form-check-input" type="checkbox" role="switch">' +
                    '</div>';
                graphCommandsRow.appendChild(switchDIV);

                this.switchInput = switchDIV.getElementsByTagName("input")[0];
                this.switchInput.addEventListener("change", function () {
                    this.displayMode = this.switchInput.checked ? "ranks" : "scores";
                    this.updateGraph();
                }.bind(this));
            }


            // ------------------ Search bar ------------------
            // create search bar for alliance/commander name
            let autocompletePlaceHolder;
            if (this.mode === "commander" || this.mode === "commanderProfile") {
                autocompletePlaceHolder = translator.translate("Commander Name");
            } else {
                autocompletePlaceHolder = translator.translate("Alliance Name");
            }

            let searchIconSpan = document.createElement("span");
            searchIconSpan.style.fontSize = "120%";
            searchIconSpan.innerText = translator.translate("Search: ");
            searchIconSpan.style.fontWeight = "bold";
            searchIconSpan.style.verticalAlign = "middle";
            searchIconSpan.style.marginLeft = "10px";
            graphCommandsRow.appendChild(searchIconSpan);


            let autocompleteDIV = document.createElement("div");
            autocompleteDIV.style.display = "inline-block";
            autocompleteDIV.style.width = "200px";
            autocompleteDIV.style.verticalAlign = "middle";
            autocompleteDIV.style.textAlign = "left";

            graphCommandsRow.appendChild(autocompleteDIV);
            let inputName = divId + "_commanderInput";
            let clearButtonName = divId + "_clearButton";
            autocompleteDIV.innerHTML = '' +
                '<div class="autocomplete_container" >' +
                '<input id="' + inputName + '" type="text" tabindex="-1" name="commander_name" placeholder="' + autocompletePlaceHolder + '">' +
                '<span title="' + translator.translate("Clear name") + '" class="button" id="' + clearButtonName + '" style="display: none;cursor: pointer;">⌫</span>' +
                '</div>';

            let input_field = document.getElementById(inputName);
            let button_clear = document.getElementById(clearButtonName);

            button_clear.addEventListener("click", function (e) {
                input_field.value = "";
                input_field.dispatchEvent(new Event('input'));
                button_clear.style.display = "none";
                //button_search.style.display = "inline";
            });

            function initAutoComplete(widget) { // init auto complete
                function autocomplete(inp, nameDict) {
                    /*the autocomplete function takes two arguments,
                    the text field element and an array of possible autocompleted values:*/
                    var currentFocus;

                    function onInputUpdate(elem) {
                        var a, b, i, val = elem.value;
                        /*close any already open lists of autocompleted values*/
                        closeAllLists();
                        if (!val) {
                            button_clear.style.display = "none";
                            //button_search.style.display = "inline";
                            return false;
                        } else {
                            //button_search.style.display = "none";
                            button_clear.style.display = "inline";
                        }
                        currentFocus = -1;
                        /*create a DIV element that will contain the items (values):*/
                        a = document.createElement("DIV");
                        a.setAttribute("id", elem.id + "autocomplete-list");
                        a.setAttribute("class", "autocomplete-items");
                        /*append the DIV element as a child of the autocomplete container:*/
                        elem.parentNode.appendChild(a);
                        val = val.toLowerCase();
                        const foundNames = new Set();

                        let searchFunction = function () {

                            let boldise = function (str, index, length) {
                                return str.substring(0, index) + "<b>" + str.substring(index, index + length) + "</b>" + str.substring(index + length);
                            }

                            let addFoundElement = function (boldisedName, key) {
                                /*create a DIV element for each matching element:*/
                                let b = document.createElement("DIV");
                                b.innerHTML = boldisedName;
                                /*insert a input field that will hold the current array item's value:*/
                                b.innerHTML += "<input type='hidden' value='" + key + "'>";
                                /*execute a function when someone clicks on the item value (DIV element):*/
                                b.addEventListener("click", function (e) {
                                    /*insert the value for the autocomplete text field:*/
                                    inp.value = "";
                                    button_clear.style.display = "none";
                                    widget.addTrace(key)
                                    /*close the list of autocompleted values,
                                    (or any other open lists of autocompleted values:*/
                                    closeAllLists();
                                });
                                a.appendChild(b);
                            }

                            /* first test names*/
                            for (const [key, value] of Object.entries(nameDict)) {
                                if (key in widget.focusedEntries) {
                                    continue;
                                }
                                let name = value["name"];
                                let pos = name.toLowerCase().indexOf(val);
                                /*check if the item starts with the same letters as the text field value:*/
                                if (pos != -1) {
                                    foundNames.add(key);
                                    addFoundElement(boldise(name, pos, val.length), key);
                                }
                            }
                            for (const [key, value] of Object.entries(nameDict)) {
                                if (key in widget.focusedEntries || foundNames.has(key) || !("aliases" in value)) {
                                    continue;
                                }
                                let aliases = value["aliases"];
                                for (let j = 0; j < aliases.length; j++) {
                                    let alias = aliases[j]["name"];
                                    let pos = alias.toLowerCase().indexOf(val);
                                    /*check if the item starts with the same letters as the text field value:*/
                                    if (pos != -1) {
                                        foundNames.add(key);
                                        addFoundElement(value["name"] + " (" + boldise(alias, pos, val.length) + ")", key);
                                    }
                                }

                            }
                        }
                        searchFunction();
                    }

                    /*execute a function when someone writes in the text field:*/
                    inp.addEventListener("input", function (e) {
                        onInputUpdate(this);
                    });

                    function closeAllLists(elmnt) {
                        /*close all autocomplete lists in the document, except the one passed as an argument:*/
                        var x = document.getElementsByClassName("autocomplete-items");
                        for (var i = 0; i < x.length; i++) {
                            if (elmnt != x[i] && elmnt != inp) {
                                x[i].parentNode.removeChild(x[i]);
                            }
                        }
                    }

                    inp.addEventListener("keydown", function (e) {
                        const key = e.code || e.keyCode;
                        if (key === 'Enter' || key === 13) {
                            inp.blur();
                            /*If the ENTER key is pressed, prevent the form from being submitted,*/
                            e.preventDefault();
                        }
                    });

                    inp.addEventListener("keyup", function (e) {
                        const key = e.code || e.keyCode;
                        if (key === 'Enter' || key === 13) {
                            inp.blur();
                            /*If the ENTER key is pressed, prevent the form from being submitted,*/
                            e.preventDefault();
                        }
                    });

                    inp.addEventListener("keypress", function (e) {
                        const key = e.code || e.keyCode;
                        if (key === 'Enter' || key === 13) {
                            inp.blur();
                            /*If the ENTER key is pressed, prevent the form from being submitted,*/
                            e.preventDefault();
                        }
                    });

                    inp.addEventListener("change", function (e) {
                        inp.focus();
                        inp.blur();
                        e.preventDefault();
                        return false;
                    });

                    /*execute a function when someone clicks in the document:*/
                    document.addEventListener("click", function (e) {
                        closeAllLists(e.target);
                    });
                }

                autocomplete(input_field, nameDict);
            }

            initAutoComplete(this);




            // ------------------ Graph control buttons ------------------
            let controlButtons = document.createElement("div");
            controlButtons.style.verticalAlign = "middle";
            //controlButtons.style.float = "right";
            controlButtons.style.position = "absolute";
            controlButtons.style.right = "0px";
            controlButtons.style.bottom = "0px";
            controlButtons.style.zIndex = "1";
            controlButtons.style.fontSize = "150%";
            graphCommandsRow.appendChild(controlButtons);

            // create clear button
            let clearButton = document.createElement("span");
            clearButton.title = translator.translate("Clear graph");
            clearButton.className = "button";
            clearButton.innerText = "X"
            clearButton.addEventListener("click", function () {
                this.clearGraph();
            }.bind(this));
            controlButtons.appendChild(clearButton);

            // create reset button
            let resetButton = document.createElement("span");
            resetButton.style.marginLeft = "10px";
            resetButton.title = translator.translate("Reset graph");
            resetButton.className = "button";
            resetButton.innerText = "↺"
            resetButton.addEventListener("click", function () {
                this.resetGraph();
            }.bind(this));
            controlButtons.appendChild(resetButton);


            let chartRow = document.createElement("div");
            chartRow.style.height = Math.min(400, screen.height - 50) + "px";
            this.rootDomElement.appendChild(chartRow);
            this.chartDIV = document.createElement("div");
            this.chartDIV.id = divId + "_chartDIV";
            this.chartDIV.style.height = "inherit"
            chartRow.appendChild(this.chartDIV);


            /***********************************
             * Manipulation functions
             ***********************************/
            this.getFreeColor = function () {
                for (let i = 0; i < colorsArray.length; i++) {
                    if (!this.usedColors.has(colorsArray[i])) {
                        return colorsArray[i];
                    }
                }

                function randomInt(min, max) {
                    return Math.floor(Math.random() * (max - min + 1)) + min;
                }

                return colorsArray[randomInt(0, colorsArray.length)];
            }

            /**
             * Clears the graph and removes all entries
             */
            this.clearGraph = function () {
                this.focusedEntries = {};
                this.usedColors = new Set();
                this.updateGraph(false);
            }

            /**
             * Resets the graph to the initial state (as after fresh page load)
             */
            this.resetGraph = function () {
                this.focusedEntries = {};
                this.usedColors = new Set();
                this.updateGraph();
            }

            let scaler = function(x, rankingname){
                return Math.pow(x/dbData["maxRankingScores"][rankingname], 0.5)
            }

            let rankingScaling = {
                "commander_power": scaler,
                "commander_kill": scaler,
                "commander_city": function(x, _){ return (x-30)/11;},
                "commander_officer": scaler,
                "commander_titan": scaler,
                "commander_warplane": scaler,
                "commander_island": scaler,
                "commander_merit": scaler,
                "commander_reputation": scaler,
                "commander_loss": scaler,
                "commander_level": function(x, _){ return (x-50)/20;},
                "commander_ke_frenzy": scaler,
                "commander_sc_frenzy": scaler,
                "commander_ke_void": scaler,
                "commander_sc_void": scaler,
            }

            let ascendingRanking = new Set();
            ascendingRanking.add("alliance_elite");

            this._createSingleTraceSpiderPlot = function (entryId, color) {
                let getScore = undefined;
                if(this.mode === "commanderProfile") {
                    getScore = dbData.getCommanderScores;
                    entry = dbData["commanders"][entryId];
                } else {
                    getScore = dbData.getAllianceScores;
                    entry = dbData["alliances"][entryId];
                }

                let scores = [];
                let scoresNormalized = [];
                let ranks = [];

                for (let i = 0; i < this._rankingNames.length; i++) {
                    let d = getScore(entryId, this._rankingNames[i], 1);
                    if(d.scores.length === 0) {
                        scores.push(0);
                        scoresNormalized.push(0);
                        ranks.push(101);
                    } else {
                        scores.push(d.scores[0]);
                        scoresNormalized.push(rankingScaling[this._rankingNames[i]](d.scores[0], this._rankingNames[i]));
                        ranks.push(d.ranks[0]);
                    }
                }

                scores.push(scores[0]);
                scoresNormalized.push(scoresNormalized[0]);
                ranks.push(ranks[0]);
                let hovertext = [];
                for (let i = 0; i < this._rankingNames.length; i++) {
                    if(ranks[i] === 101){
                        hovertext.push(translator.translate("No data"));
                    } else {
                        if (ranks[i] === -1){
                            hovertext.push(formatScore(scores[i]));
                        }else{
                            hovertext.push(formatScore(scores[i]) + " (" + translator.translate("Rank: ") + ranks[i] + ")");
                        }
                    }

                }
                hovertext.push(hovertext[0]);

                color = color || this.getFreeColor();
                this.usedColors.add(color);
                this.focusedEntries[entryId] = color;
                let trace ={
                    type: 'scatterpolar',
                    r: scoresNormalized,
                    text: hovertext,
                    hovertemplate: '%{text}',
                    theta: this._rankingNamesTranslated,
                    line: {color: this.focusedEntries[entryId]},
                    //fill: 'toself',
                    entry_id: entryId,
                    name: entry["name"],
                    showlegend: true
                }
                return trace;
            }

            /**
             * Adds a new entry to the graph (use batched version for better performance)
             * @param entryId
             * @param color (optional)
             * @returns a plotly trace
             * @private
             */
            this._createSingleTraceSingleRanking = function (entryId, color) {
                let entry;
                let entryScore;
                if (this.mode === "commander") {
                    entry = dbData["commanders"][entryId];
                    entryScore = dbData.getCommanderScores(entry["id"], this.rankingName);
                } else {
                    entry = dbData["alliances"][entryId];
                    entryScore = dbData.getAllianceScores(entry["id"], this.rankingName);
                }

                color = color || this.getFreeColor();
                this.usedColors.add(color);
                this.focusedEntries[entryId] = color;
                if (!this.isDisplayRanks()){
                    let rank = (entryScore["ranks"].length > 0)? entryScore["ranks"][0]:1000;
                    let trace = {
                        type: "scatter",
                        //mode: "lines",
                        name: (rank != 1000 && rank != -1)?(entry["name"] + " (" + rank + ")"):entry["name"],
                        x: (entryScore["dates"].length > 0)? entryScore["dates"] : [null],
                        y: (entryScore["scores"].length > 0)? entryScore["scores"] : [null],
                        line: {color: this.focusedEntries[entryId]}, //colorsArray[i % colorsArray.length]
                        opacity: 1,
                        entry_id: entryId,
                        legendrank: rank,
                        showlegend: true
                    }
                    return trace;
                } else {
                    let rank = (entryScore["ranks"].length > 0)? entryScore["ranks"][0]:1000;
                    // if ranking is missing, set it to 101
                    for (let i = 0; i < entryScore["ranks"].length; i++) {
                        if (entryScore["ranks"][i] === -1){
                            entryScore["ranks"][i] = 101;
                        }
                    }
                    let trace = {
                        type: "scatter",
                        //mode: "lines",
                        name: entry["name"],
                        x: (entryScore["dates"].length > 0)? entryScore["dates"] : [null],
                        y: (entryScore["ranks"].length > 0)? entryScore["ranks"] : [null],
                        line: {color: this.focusedEntries[entryId]}, //colorsArray[i % colorsArray.length]
                        opacity: 1,
                        entry_id: entryId,
                        legendrank: rank,
                        showlegend: true
                    }
                    return trace;
                }
            }




            /**
             * Adds one or several new entries to the graph
             * @param entryId (can be an array of entry ids)
             * @param color (optional) (can be an array of colors)
             */
            this.addTrace = function (entryId, color) {
                let traces = [];
                if (Array.isArray(entryId)) {
                    if (color) {
                        for (let i = 0; i < entryId.length; i++) {
                            traces.push(this._createSingleTrace(entryId[i], color[i]));
                        }
                    } else {
                        for (let i = 0; i < entryId.length; i++) {
                            traces.push(this._createSingleTrace(entryId[i]));
                        }
                    }
                } else {
                    traces.push(this._createSingleTrace(entryId, color));
                }
                Plotly.addTraces(this.chartDIV, traces);
            }

            let layoutScatter = {
                xaxis: {
                    autorange: true,
                    //range: ['2015-02-17', '2017-02-16'],
                    rangeselector: {
                        buttons: [
                            {
                                count: 1,
                                label: '1m',
                                step: 'month',
                                stepmode: 'backward'
                            },
                            {
                                count: 6,
                                label: '6m',
                                step: 'month',
                                stepmode: 'backward'
                            },
                            {step: 'all'}
                        ]
                    },
                    //rangeslider: {range: ['2015-02-17', '2017-02-16']},
                    type: 'date'
                },
                yaxis: {
                    autorange: true,
                    //range: [86.8700008333, 138.870004167],
                    type: 'linear'
                },
                margin: {
                    l: 50,
                    r: 50,
                    b: 50,
                    t: 50,
                    pad: 4
                },

            };

            let layoutSpider = {
                polar: {
                    radialaxis: {
                      visible: false,
                      range: [0, 1],
                    },

                  },
                margin: {
                    l: 50,
                    r: 50,
                    b: 50,
                    t: 50,
                    pad: 4
                },
                //dragmode: false,
                legend :  {orientation : 'h', xanchor : "center", x : 0.5, y: -0.2}
            }




            /**
             * Clears all traces from the graph, do not reset focusedEntries
             * @private
             */
            this._clearTraces = function () {
                let traces = []
                for (let i = 0; i < this.chartDIV.data.length; i++) {
                    traces.push(i);
                }
                Plotly.deleteTraces(this.chartDIV, traces);

            }

            this.updateGraph = function (defaultTrace = true) {
                this._clearTraces();
                if (this.mode === "commanderProfile" || this.mode === "AllianceProfile") {

                    // add fake entry to avoid degenerate plot when no entries are selected
                    let scores = [];
                    for (let i = 0; i < this._rankingNames.length; i++) {
                        scores.push(0);
                    }

                    scores.push(scores[0]);


                    let trace ={
                        type: 'scatterpolar',
                        r: scores,
                        hovertemplate: " ",
                        line: {color: "rgba(0,0,0,0)"},
                        theta: this._rankingNamesTranslated,
                        fill: 'toself',
                        entry_id: -1,
                        showlegend: false,
                        name: "",
                    }

                    Plotly.addTraces(this.chartDIV, [trace]);
                }

                 if (Object.keys(this.focusedEntries).length === 0 && defaultTrace) {
                    let top_entries;
                    let order = (ascendingRanking.has(this.rankingName))? "ASC" : "DESC";
                    if (this.mode === "commander") {
                        top_entries = this.aooStats.getHighestRankedCommanders(this.rankingName, 10, order);
                    } else if (this.mode === "alliance"){
                        top_entries = this.aooStats.getHighestRankedAlliances(this.rankingName, 5, order);
                    } else if (this.mode === "commanderProfile"){
                        top_entries = this.aooStats.getHighestRankedCommanders("commander_officer", 3, order);
                    } else if (this.mode === "AllianceProfile"){
                        top_entries = this.aooStats.getHighestRankedAlliances("alliance_power", 3, order);
                    }
                    this.addTrace(top_entries);

                } else {
                    let keys = [];
                    let colors = [];
                    for (const [key, color] of Object.entries(this.focusedEntries)) {
                        keys.push(key);
                        colors.push(color);
                    }
                    this.addTrace(keys, colors);
                }

                if (this.mode === "commander" || this.mode === "alliance") {
                    if (this.isDisplayRanks()) {
                        Plotly.relayout(this.chartDIV, {
                            'xaxis.autorange': true,
                            'yaxis.autorange': "reversed",
                        });
                    }else {
                        // first relayout forces to have yaxis is increasing order
                        Plotly.relayout(this.chartDIV, {
                            'xaxis.autorange': true,
                            'yaxis.range': [0,1],
                        });
                        Plotly.relayout(this.chartDIV, {
                            'xaxis.autorange': true,
                            'yaxis.autorange': true,
                        });
                    }
                } else{
                    Plotly.relayout(this.chartDIV, {
                        'polar.radialaxis.range': [0,1],
                    });
                }
            }

            this._setRankingName = function (rankingName, defaultTrace = true) {
                this.rankingName = rankingName;
                this.updateGraph(defaultTrace);
            }

            let layout = undefined;

            if (this.mode === "commander" || this.mode === "alliance") {
                this._createSingleTrace = this._createSingleTraceSingleRanking;
                this.setRankingName = this._setRankingName;
                layout = layoutScatter;
            } else if (this.mode === "commanderProfile" || this.mode === "allianceProfile") {
                this._createSingleTrace = this._createSingleTraceSpiderPlot;
                layout = layoutSpider;
                this._rankingNamesTranslated = [];
                this._rankingNames = ranking_lists[this.mode];
                for (let i = 0; i < this._rankingNames.length; i++) {

                    this._rankingNamesTranslated.push(translator.translate(this._rankingNames[i]));
                }
                this._rankingNamesTranslated.push(this._rankingNamesTranslated[0]);
            } else {
                throw "Unknown mode: " + this.mode;
            }


            var config = {
                responsive: true,
                modeBarButtonsToRemove: ['select2d', 'lasso2d', 'hoverClosestCartesian', 'hoverCompareCartesian'],
                displaylogo: false,
            }
            Plotly.newPlot(this.chartDIV, [], layout, config);

             //plotly remove trace from legend when clicked
            this.chartDIV.on('plotly_legendclick', function (data) {
                let traceIndex = data.curveNumber;
                let trace = data.data[traceIndex];
                let commanderId = trace.entry_id;
                this.usedColors.delete(this.focusedEntries[commanderId])
                delete this.focusedEntries[commanderId];

                Plotly.deleteTraces(this.chartDIV, traceIndex);
                return false;
            }.bind(this));

            if (this.setRankingName !== undefined) {
                this.setRankingName(this.rankingName);
            } else{
                this.updateGraph();
            }
        }


        return rankingWidget;
    })();


    return dbData;
}