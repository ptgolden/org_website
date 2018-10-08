"use strict";

const N3 = require('n3')
    , Cite = require('citation-js')
    , { DateParser } = require('citeproc')
    , { rdfListToArray, findOne } = require('org-n3-utils')
    , { expandNS, isType, getDCContainer } = require('./rdf')

const bibRDFTypes = {
  'bibo:BookSection': bookSection,
  'bibo:AcademicArticle': academicArticle,
  'bibo:Book': book,
  ':ConferencePaper': conferencePaper,
  ':Lecture': lecture,
}

module.exports = function getBibEntries(store) {
  const cslItems = Object.entries(bibRDFTypes).reduce((acc=[], [rdfType, fn]) =>
    acc.concat(
      store
        .getSubjects(expandNS('rdf:type'), expandNS(rdfType))
        .map(uri => {
          const def = fn(store, uri)

          try {
            return execCSLDefinition(store, uri, def)
          } catch (e) {
            console.error('Error generating CSL for URI: ' + uri.value);
            throw e;
          }
        })
    )
  , [])

  return new Map(cslItems.map(csl => [
    csl.id,
    new Cite(csl).get({
      type: 'html',
      style: 'citation-apa',
      lang: 'en-US',
    })
  ]))
}

function bookSection(store, uri) {
  const $chapter = uri
      , $book = getDCContainer(store, $chapter)

  const [ $publisher ] = store
    .getObjects($book, expandNS('dc:publisher'))
    .filter(isType(store, expandNS(':Publisher')))

  return {
    type: 'chapter',
    agentFields: ['author', 'editor'],
    dateFields: ['issued'],
    fields: {
      title: [$chapter, 'dc:title'],
      page: [$chapter, 'bibo:pages'],
      URI: [$chapter, 'bibo:uri'],
      DOI: [$chapter, 'bibo:doi'],
      author: [$chapter, 'bibo:authorList'],
      'container-title': [$book, 'dc:title'],
      issued: [$book, 'dc:date'],
      editor: [$book, 'bibo:editorList'],
      publisher: [$publisher, 'foaf:name'],
      'publisher-place': [$publisher, 'address:localityName'],
    },
  }
}

function lecture(store, uri) {
  const $lecture = uri

  return {
    type: 'book', // Whatever, as long as all the fields are in there.
    agentFields: ['author'],
    dateFields: ['event-date', 'issued'],
    fields: {
      title: [$lecture, 'dc:title'],
      URI: [$lecture, 'bibo:uri'],
      DOI: [$lecture, 'bibo:doi'],
      author: [$lecture, 'bibo:authorList'],
      medium: [$lecture, 'dc:format'],

      'event-date': [$lecture, 'dc:created'],
      issued: [$lecture, 'dc:issued'],
    },
  }
}


function academicArticle(store, uri) {
  const $article = uri
      , $issue = getDCContainer(store, $article)
      , $journal = getDCContainer(store, $issue)

  return {
    type: 'article-journal',
    agentFields: ['author'],
    dateFields: ['issued'],
    fields: {
      title: [$article, 'dc:title'],
      page: [$article, 'bibo:pages'],
      URI: [$article, 'bibo:uri'],
      DOI: [$article, 'bibo:doi'],
      author: [$article, 'bibo:authorList'],
      'container-title': [$journal, 'dc:title'],
      issued: [
        [$article, 'dc:date'],
        [$issue, 'dc:date'],
      ],
      volume: [$issue, 'bibo:volume'],
      issue: [$issue, 'bibo:issue'],
    },
  }
}

function book(store, uri) {
  const $book = uri

  const [ $publisher ] = store
    .getObjects($book, 'dc:publisher')

  return {
    type: 'book',
    agentFields: ['author', 'editor'],
    dateFields: ['issued'],
    fields: {
      title: [$book, 'dc:title'],
      page: [$book, 'bibo:pages'],
      URI: [$book, 'bibo:uri'],
      DOI: [$book, 'bibo:doi'],
      author: [$book, 'bibo:authorList'],
      editor: [$book, 'bibo:editorList'],
      issued: [$book, 'dc:date'],
      publisher: [$publisher, 'foaf:name'],
      'publisher-place': [$publisher, 'address:localityName'],
    },
  }
}

function conferencePaper(store, uri) {
  const $paper = uri
      , $conference = findOne(store, $paper, expandNS('bibo:presentedAt'), null).object
      , $proceedings = findOne(store, $paper, expandNS('bibo:reproducedIn'), null).object
      , $publisher = findOne(store, $proceedings, expandNS('dc:publisher'), null).object

  return {
    type: 'paper-conference',
    agentFields: ['author'],
    dateFields: ['issued'],
    fields: {
      title: [$paper, 'dc:title'],
      'container-title': [$proceedings, 'dc:title'],
      'collection-title': [$conference, 'dc:title'],
      'event-place': [$conference, 'address:localityName'],
      publisher: [$publisher, 'foaf:name'],
      'publisher-place': [$publisher, 'address:localityName'],
      page: [$paper, 'bibo:pages'],
      URI: [$paper, 'bibo:uri'],
      DOI: [$paper, 'bibo:doi'],
      author: [$paper, 'bibo:authorList'],
      issued: [$proceedings, 'dc:date'],
    },
  }
}



function execCSLDefinition(store, uri, def) {
  const csl = {
    id: uri.value.split(':').slice(-1)[0],
    type: def.type,
  }

  Object.entries(def.fields).forEach(([cslKey, paths]) => {
    if (!Array.isArray(paths[0])) {
      paths = [paths]
    }

    for (let i = 0; i < paths.length; i++) {
      const [ s, p ] = paths[i]
          , [ o ] = store.getObjects(s, expandNS(p))

      if (o) {
        csl[cslKey] = o;
        break;
      }
    }
  })

  def.agentFields.forEach(field => {
    const agents = rdfListToArray(store, csl[field]).map(uri => {
      const agent = {}

      store.forEach(({ predicate, object }) => {
        if (predicate.equals(expandNS('foaf:name'))) {
          agent.name = object.value
        }

        if (predicate.equals(expandNS('foaf:givenname'))) {
          agent.given = object.value
        }

        if (predicate.equals(expandNS('foaf:surname'))) {
          agent.family = object.value
        }

        if (predicate.equals(expandNS('bibo:suffixName'))) {
          agent.suffix = object.value
        }

      }, uri)

      return agent
    })

    csl[field] = agents;
  })

  Object.entries(csl).forEach(([k, v]) => {
    if (N3.Util.isLiteral(v)) csl[k] = v.value
  })

  csl.issued = DateParser.parseDateToArray(csl.issued)

  return csl
}
