const BrowserWindow = require('electron').remote.BrowserWindow;
const path = require('path')
const url = require('url')
var fs = require('fs')
var childProcess = require('child_process');

document.addEventListener("DOMContentLoaded", function(event) {
    function openAccount(login) {
        childProcess.execSync(`node /var/bot/manager/start.js ${login}`);
    }
    var getAccounts = function (dir, files_){
        files_ = files_ || [];
        var files = fs.readdirSync(dir);
        for (var i in files){
            var name = dir + '/' + files[i];
            if (fs.statSync(name).isDirectory()){
                getFiles(name, files_);
            } else {
                files_.push(files[i].replace('.json', ''));
            }
        }
        return files_;
    };
    var accounts = getAccounts('./cookies')
    var table = document.getElementById('table')
    accounts.forEach(function (account) {
        if(account != 'cookie'){
            var tr = document.createElement("tr")
            tr.innerHTML = `<th scope="row">${account}</th> <td><button type="button" value="${account}" class="btn btn-primary">Открыть</button></td>`
            table.appendChild(tr);
        }
    })
    var btns = document.querySelectorAll('button')

    btns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            openAccount(e.target.value)
        })
    })
});

